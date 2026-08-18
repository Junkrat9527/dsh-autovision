// Server half of the dsh-autovision plugin (v2): image fidelity + auto text.
//
// v1 pasted an image, transcribed it, and inserted the TEXT into the composer
// (the model saw the description; the UI never showed the picture). This
// version inverts that: the picture stays a real attachment — thumbnail in
// the composer, image block in the durable message, both rendered by dsh's
// own UI — while every request to a text-only model carries only the
// transcription text. The user sees the image; the model sees words.
//
// How it works, against the 5-layer image gate (see the architecture note):
//
// 1. A text-only model's session must look image-capable or the host's wire
//    admission (api-proxy prompt/selectModel) rejects the paste. There is no
//    way to re-declare an existing adapter's model (DUPLICATE_ADAPTER), so we
//    register a sibling TWIN route "<provider>-autovision" per text-only model
//    that advertises inputModalities ['text','image'] — the gate then passes.
// 2. The twin's stream() converts every image block in the wire messages
//    (recursively, including inside tool-result — dsh's own read_image nests
//    one there) into a transcription from the configured default vision model,
//    then delegates to the upstream text model. The durable session log keeps
//    the real image blocks, so the UI shows the picture natively.
// 3. The session is pointed at the twin AUTOMATICALLY via the official
//    `agent/request` waterfall extension point (prepend, outermost), so it
//    overrides the host's own model selection without ever writing settings —
//    no NO_ADAPTER, survives restart through the logged request header.
//
// Zero dsh package imports (out-of-tree resolution of @deepseek-ai/* is not
// reliable): only services Cordis injects into the plugin ctx — llm,
// attachments — plus a scoped webServer inject for the routes.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const CONFIG_FILE = join(DSH_HOME, 'autovision', 'config.json')

const DEFAULT_PROMPT =
  '请详细描述这张图片：包括文字内容（中英文逐字转写）、颜色、形状、数字、' +
  'UI 元素、图标、布局和可能的状态。'
const DESCRIBE_TIMEOUT_MS = 45000
const MAX_IMAGE_BYTES = 5 * 1024 * 1024 // attachment-local default; keep in step
const EVIDENCE_CACHE_LIMIT = 64

const TWIN_SUFFIX = '-autovision'

// png/jpeg/webp/gif — exactly the set attachment-local's saveImage admits.
const SNIFFS = [
  { mediaType: 'image/png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mediaType: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mediaType: 'image/webp', test: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
  { mediaType: 'image/gif', test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
]

function sniffMediaType(buffer) {
  const match = SNIFFS.find((s) => s.test(buffer))
  return match ? match.mediaType : null
}

async function readConfig() {
  try {
    const raw = await readFile(CONFIG_FILE, 'utf8')
    return normalizeConfig(JSON.parse(raw))
  } catch {
    return normalizeConfig({})
  }
}

function normalizeConfig(input) {
  const cfg = input && typeof input === 'object' ? input : {}
  const m = cfg.defaultVisionModel
  const defaultVisionModel =
    m && typeof m === 'object' && typeof m.provider === 'string' && m.provider && typeof m.model === 'string' && m.model
      ? { provider: m.provider, model: m.model }
      : null
  return {
    enabled: cfg.enabled !== false,
    defaultVisionModel,
    prompt: typeof cfg.prompt === 'string' && cfg.prompt ? cfg.prompt : DEFAULT_PROMPT,
    targetProviders: Array.isArray(cfg.targetProviders) ? cfg.targetProviders.filter((x) => typeof x === 'string') : [],
  }
}

async function writeConfig(cfg) {
  await mkdir(join(DSH_HOME, 'autovision'), { recursive: true })
  await writeFile(CONFIG_FILE, JSON.stringify(normalizeConfig(cfg), null, 2), { mode: 0o600 })
}

const twinIdFor = (upstream) => `${upstream}${TWIN_SUFFIX}`
const isTwinId = (provider) => typeof provider === 'string' && provider.endsWith(TWIN_SUFFIX)

// The host-side image admission and read_image tool all read
// resolveModelInfo().inputModalities (not listModels, which is advisory), so
// the twin must declare image on BOTH surfaces.
const withVision = (info, twinId) => {
  const inputModalities = Array.isArray(info?.inputModalities) ? [...info.inputModalities] : []
  if (!inputModalities.includes('text')) inputModalities.unshift('text')
  if (!inputModalities.includes('image')) inputModalities.push('image')
  return { ...info, provider: twinId, inputModalities }
}

// ---- transcription core ----------------------------------------------------
//
// One image block -> text via the configured default vision model. The block
// already carries a durable ref (host saveImage'd it), which the vision
// model's adapter reads itself; we never touch the bytes.

async function transcribeBlock(ctx, block, vision, signal) {
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'image', attachment: block.attachment },
        { type: 'text', text: vision.prompt },
      ],
    },
  ]
  let text = ''
  for await (const chunk of ctx.llm.stream({
    provider: vision.provider,
    model: vision.model,
    messages,
    purpose: 'autovision',
    maxTokens: 1024,
    signal,
  })) {
    if (chunk.type === 'text-delta' && chunk.text) text += chunk.text
  }
  const trimmed = text.trim()
  if (!trimmed) throw new Error('vision model returned no text')
  return trimmed
}

// Promise-caching per image (the same pasted attachment rides every later
// step). Concurrent steps join the first read; failed reads evict so a fixed
// config gets a fresh chance; LRU-capped for a long-lived profile. Resolves to
// a ready text block (what convertBlocks pushes into message content), not a
// {ok,text} envelope — the wire must see content blocks.
function cachedTranscription(ctx, adapter, block, vision) {
  const key = JSON.stringify(block.attachment ?? block)
  const hit = adapter.evidenceCache.get(key)
  if (hit !== undefined) {
    adapter.evidenceCache.delete(key)
    adapter.evidenceCache.set(key, hit)
    return hit
  }
  const pending = transcribeBlock(ctx, block, vision, undefined).then(
    (text) => ({ type: 'text', text: `[图片由默认识图模型识别]\n${text}` }),
    (error) => {
      if (adapter.evidenceCache.get(key) === pending) adapter.evidenceCache.delete(key)
      return {
        type: 'text',
        text: `[图片识别失败：${error instanceof Error ? error.message.slice(0, 300) : String(error)}]`,
      }
    },
  )
  adapter.evidenceCache.set(key, pending)
  while (adapter.evidenceCache.size > EVIDENCE_CACHE_LIMIT) {
    adapter.evidenceCache.delete(adapter.evidenceCache.keys().next().value)
  }
  return pending
}

// Wait on a shared promise without inheriting its lifetime: the caller's
// abort rejects THIS wait immediately, the underlying read keeps running.
function abortableWait(promise, signal) {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const onAbort = () => reject(signal.reason ?? new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

// Image blocks hide at two depths: top-level message content (pastes) and
// inside tool-result content (dsh's own read_image nests one there). The
// conversion must recurse the same way or a nested image wedges the session.
function contentHasImage(blocks) {
  return (
    Array.isArray(blocks) &&
    blocks.some((b) => b?.type === 'image' || (b?.type === 'tool-result' && contentHasImage(b.content)))
  )
}

async function convertBlocks(blocks, convertOne) {
  const out = []
  for (const block of blocks) {
    if (block?.type === 'image') {
      out.push(await convertOne(block))
    } else if (block?.type === 'tool-result' && contentHasImage(block.content)) {
      out.push({ ...block, content: await convertBlocks(block.content, convertOne) })
    } else {
      out.push(block)
    }
  }
  return out
}

async function convertImagesToText(ctx, messages, signal, adapter, vision) {
  const out = []
  for (const message of messages) {
    if (!contentHasImage(message.content)) {
      out.push(message)
      continue
    }
    const content = await convertBlocks(message.content, (block) =>
      abortableWait(cachedTranscription(ctx, adapter, block, vision), signal),
    )
    out.push({ ...message, content })
  }
  return out
}

// Assistant model messages written by the twin's own upstream delegation
// carry source.provider = twin id; the log/UI side stays coherent if those
// read as the real provider again.
function restoreUpstreamSource(messages, twinId, upstream) {
  let changed = false
  const out = messages.map((message) => {
    const source = message?.source
    if (message?.role !== 'assistant' || source?.kind !== 'model' || source.provider !== twinId) {
      return message
    }
    changed = true
    return { ...message, source: { ...source, provider: upstream } }
  })
  return changed ? out : messages
}

// ---- twin adapter registration ---------------------------------------------

function registerVisionTwin(ctx, config) {
  // Text-only models we have twinned, as "provider::model", the set
  // agent/request consults to decide whether to redirect a request.
  const wrapped = new Set()
  // Registered twin id -> { upstream, state, registration }
  const registrations = new Map()

  const shouldWrap = (info) => !(Array.isArray(info?.inputModalities) && info.inputModalities.includes('image'))

  const registerWrapper = (upstream, models) => {
    const twinId = twinIdFor(upstream)
    if (registrations.has(upstream)) {
      models.forEach((m) => wrapped.add(`${upstream}::${m.id}`))
      return
    }
    const state = { displayName: `${upstream}${TWIN_SUFFIX}` }
    try {
      const registration = ctx.llm.registerAdapter([twinId], {
        providerInfo(provider) {
          return { id: provider, name: state.displayName }
        },
        providerRetryPolicy() {
          if (typeof ctx.llm.providerRetryPolicy !== 'function') return undefined
          return ctx.llm.providerRetryPolicy(upstream)
        },
        async listModels(_provider, signal) {
          // Empty catalog: dsh's buildModelCatalog drops groups whose model
          // list is empty (api-proxy `groups.filter(g => g.models.length)`),
          // so the twin never shows as an "(autovision)" group in the model
          // selector or llm.models. listModels is advisory — requests still
          // route (agent/request redirect), admission still reads
          // resolveModelInfo()'s inputModalities. This is what keeps the
          // selector clean while the twin keeps working.
          void upstream
          void signal
          return []
        },
        async resolveModel(_provider, model, signal) {
          // Use the ORIGINAL (pre-patch) resolveModelInfo here: admission-time
          // patch makes every wrapped text model report image, which would
          // otherwise make this shouldWrap guard misfire ("twin no longer
          // applies") on the very models the twin exists for.
          const resolveInfo = ctx.llm.__autovisionOriginalResolveModelInfo || ctx.llm.resolveModelInfo.bind(ctx.llm)
          const info = await resolveInfo(upstream, model, signal)
          if (!shouldWrap(info)) {
            throw new Error(`model "${model}" declares native image input; its "(autovision)" twin no longer applies`)
          }
          return { ...withVision(info, twinId), id: model }
        },
        stream(options) {
          const self = this
          return (async function* () {
            const cfg = await readConfig()
            const vision = cfg.defaultVisionModel
              ? { provider: cfg.defaultVisionModel.provider, model: cfg.defaultVisionModel.model, prompt: cfg.prompt }
              : null
            if (!vision) {
              const out = restoreUpstreamSource(convertImagesToTextWithoutVision(options.messages), twinId, upstream)
              yield* ctx.llm.stream({ ...options, provider: upstream, messages: out })
              return
            }
            const converted = await convertImagesToText(ctx, options.messages, options.signal, self, vision)
            const messages = restoreUpstreamSource(converted, twinId, upstream)
            yield* ctx.llm.stream({ ...options, provider: upstream, messages })
          })()
        },
        evidenceCache: new Map(),
      })
      registrations.set(upstream, { twinId, registration, state })
      models.forEach((m) => wrapped.add(`${upstream}::${m.id}`))
      return true
    } catch (error) {
      const duplicate =
        error?.code === 'DUPLICATE_ADAPTER' ||
        /\balready registered\b|\bduplicate (adapter|provider)\b/i.test(String(error))
      if (duplicate) {
        console.error(`[dsh-autovision] twin ${twinId} already registered, keeping the existing one`)
        return false
      }
      console.error(`[dsh-autovision] twin registration skipped (${twinId}): ${error}`)
      return false
    }
  }

  // Discover text-only models across providers and twin them. Runs on apply
  // and re-runs on every llm/adapters-updated so a reconfigured provider gets
  // its twin.
  const sync = async () => {
    const cfg = await readConfig()
    if (cfg.enabled === false) return
    const providers = ctx.llm.listProviders()
    for (const provider of providers) {
      if (isTwinId(provider.id)) continue
      if (cfg.targetProviders.length && !cfg.targetProviders.includes(provider.id)) continue
      let models
      try {
        models = await ctx.llm.listModels(provider.id)
      } catch {
        continue
      }
      const textOnly = models.filter(shouldWrap)
      if (textOnly.length === 0) continue
      registerWrapper(provider.id, textOnly)
    }
  }

  if (typeof ctx.llm?.registerAdapter === 'function' && typeof ctx.llm?.stream === 'function') {
    void sync()
    if (typeof ctx.on === 'function') {
      ctx.on('llm/adapters-updated', () => void sync())
    }
  }

  return {
    isWrapped: (provider, model) => wrapped.has(`${provider}::${model}`),
    twinFor: (provider) => (registrations.has(provider) ? twinIdFor(provider) : null),
  }
}

// No vision model configured: replace images with an honest text note rather
// than failing the request.
function convertImagesToTextWithoutVision(messages) {
  return messages.map((message) => {
    if (!contentHasImage(message.content)) return message
    const walk = (blocks) =>
      blocks.map((block) => {
        if (block?.type === 'image') {
          return { type: 'text', text: '[图片：未配置默认识图模型，无法自动识别。请到 设置 → dsh-autovision 选择视觉模型。]' }
        }
        if (block?.type === 'tool-result' && contentHasImage(block.content)) {
          return { ...block, content: walk(block.content) }
        }
        return block
      })
    return { ...message, content: walk(message.content) }
  })
}

// ---- automatic redirect to the twin ----------------------------------------
//
// The official `agent/request` waterfall (the same extension point dsh's own
// installModelSelection uses) can replace the frozen call config per request.
// prepend puts us outermost, so our twin override wins over the host's
// session selection — and we never write settings.yaml.

function installAutoRedirect(ctx, twin) {
  if (typeof ctx.on !== 'function') return
  ctx.on('agent/created', ({ agent }) => {
    if (!agent?.ctx || typeof agent.ctx.on !== 'function') return
    agent.ctx.on(
      'agent/request',
      async (_payload, next) => {
        const cfg = await next()
        if (!cfg?.provider || !cfg?.model) return cfg
        if (isTwinId(cfg.provider)) return cfg
        if (twin.isWrapped(cfg.provider, cfg.model)) {
          return { ...cfg, provider: twin.twinFor(cfg.provider) }
        }
        return cfg
      },
      { prepend: true },
    )
  })
}

// ---- admission-time image declaration ---------------------------------------
//
// The host's selectModel and send-message admission both read
// `ctx.llm.resolveModelInfo(...).inputModalities` through
// selectionFor.current. When the user manually picks a text-only model in a
// session that already contains images, that admission rejects the switch
// ("does not accept image input, but this session already contains images") —
// even though our agent/request redirect would transparently route the request
// through the twin. So the twin must also declare image at ADMISSION time, not
// just at catalog/stream time.
//
// We wrap the public resolveModelInfo: for a text-only model that has a twin,
// append 'image' to its declared inputModalities. selectModel then passes the
// switch, the current stays on the original (displayed) model, and the request
// still lands on the twin (which converts images to text before reaching the
// upstream). Purely in-memory method wrapping — no config, no core edit,
// survives restart, no re-patch on dsh upgrade.
function patchResolveModelInfo(ctx, twin) {
  const llm = ctx.llm
  if (!llm || typeof llm.resolveModelInfo !== 'function') return
  const original = llm.resolveModelInfo.bind(llm)
  // Expose the unpatched resolver so the twin's resolveModel can still tell
  // whether a model is NATIVELY image-capable (its shouldWrap guard), instead
  // of seeing the admission-time image declaration we add below.
  llm.__autovisionOriginalResolveModelInfo = original
  llm.resolveModelInfo = async (provider, model, signal) => {
    const info = await original(provider, model, signal)
    if (info && twin.isWrapped(provider, model)) {
      const inputModalities = Array.isArray(info.inputModalities) ? [...info.inputModalities] : []
      if (!inputModalities.includes('image')) inputModalities.push('image')
      return { ...info, inputModalities }
    }
    return info
  }
}

// ---- autonomous read-image tool --------------------------------------------
//
// Give the (text-only) agent its own "look at this image" tool: it reads a
// file path, transcribes it with the configured vision model (the same
// defaultVisionModel + recognition prompt the twin uses), and returns the
// TEXT to the model — the image bytes never enter the text model's context.
// The optional `prompt` arg is how the model tailors the description to the
// task ("what does the error dialog say?", "read just the labels"): no fixed
// template. Registers beside the host's native read_image (different name, no
// clash). Scoped to the web profile via inject; on headless tools is absent
// and we skip gracefully — the twin's paste transcription is unaffected.
function registerAutovisionTool(ctx) {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['tools'], (scope) => {
    const tools = scope.tools
    if (!tools || typeof tools.register !== 'function') {
      console.error('[dsh-autovision] tools service unavailable; skipping autovision_read_image')
      return
    }
    const definition = {
      name: 'autovision_read_image',
      description:
        'Read an image file (path) and return a text description of it, produced by the configured vision model. ' +
        'Use this to understand images/screenshots referenced by file path. Optionally pass `prompt` to ask for ' +
        'specific details (e.g. "transcribe only the text", "describe the layout"); defaults to an open description.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the image file (.png/.jpg/.jpeg/.webp/.gif).' },
          prompt: { type: 'string', description: 'Optional custom instruction for describing this image.' },
        },
        required: ['file_path'],
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const cfg = await readConfig()
        if (!cfg.defaultVisionModel) {
          throw new Error('autovision: no default vision model configured — set a multimodal model in dsh 设置 → LLM 供应商')
        }
        const bytes = await readFile(args.file_path)
        const mediaType = sniffMediaType(bytes)
        if (!mediaType) {
          throw new Error(`autovision: unsupported image format: ${args.file_path}`)
        }
        const ref = await ctx.attachments.saveImage({ data: bytes, mediaType, name: 'autovision-read' })
        const signal = exec?.signal || AbortSignal.timeout(DESCRIBE_TIMEOUT_MS)
        const prompt = typeof args.prompt === 'string' && args.prompt.trim() ? args.prompt.trim() : cfg.prompt
        const text = await transcribeBlock(
          ctx,
          { attachment: ref },
          { provider: cfg.defaultVisionModel.provider, model: cfg.defaultVisionModel.model, prompt },
          signal,
        )
        // Prefix so a description that happens to begin with "Error"/"fail"
        // is not mistaken by the model for a failed tool call.
        return `[图片识别结果]\n${text}`
      },
    }
    tools.register(definition)
    console.log('[dsh-autovision] tool registered: autovision_read_image')
  })
}

export function apply(ctx, config = {}) {
  const twin = registerVisionTwin(ctx, config)
  if (config.autoRedirect !== false) {
    installAutoRedirect(ctx, twin)
  }
  patchResolveModelInfo(ctx, twin)
  if (config.tool !== false) {
    registerAutovisionTool(ctx)
  }

  if (typeof ctx.inject === 'function' && config.routes !== false) {
    ctx.inject(['webServer'], (scope) => {
      const webServer = scope.webServer
      const json = (res, status, body) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(body))
      }

      // GET /autovision/models — selectable vision models (twin routes are
      // forwarding bridges, not vision engines; they are excluded).
      webServer.register({
        name: 'autovision-models',
        kind: 'exact',
        path: '/autovision/models',
        handler: async (req, res) => {
          try {
            const models = []
            for (const provider of ctx.llm.listProviders()) {
              if (isTwinId(provider.id)) continue
              let entries = []
              try {
                entries = await ctx.llm.listModels(provider.id)
              } catch {
                continue
              }
              for (const entry of entries) {
                const modalities = entry.inputModalities
                if (modalities && modalities.includes('image')) {
                  models.push({ provider: provider.id, model: entry.id, name: entry.name || entry.id })
                }
              }
            }
            json(res, 200, { models })
          } catch (error) {
            json(res, 500, { error: String(error?.message ?? error) })
          }
        },
      })

      // GET/POST /autovision/config — enabled, default vision model, prompt,
      // target provider whitelist.
      webServer.register({
        name: 'autovision-config',
        kind: 'exact',
        path: '/autovision/config',
        handler: async (req, res) => {
          if (req.method === 'GET') {
            json(res, 200, await readConfig())
            return
          }
          if (req.method !== 'POST') {
            res.writeHead(405).end()
            return
          }
          try {
            const chunks = []
            for await (const chunk of req) chunks.push(chunk)
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
            await writeConfig(body)
            json(res, 200, await readConfig())
          } catch (error) {
            json(res, 400, { error: String(error?.message ?? error) })
          }
        },
      })

      // POST /autovision/describe — image bytes in, transcription text out
      // (manual path / verification; the twin's stream conversion uses the
      // same transcribe core).
      webServer.register({
        name: 'autovision-describe',
        kind: 'exact',
        path: '/autovision/describe',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405).end()
            return
          }
          try {
            const cfg = await readConfig()
            if (!cfg.defaultVisionModel) {
              json(res, 400, { error: 'NO_VISION_MODEL' })
              return
            }
            const chunks = []
            let total = 0
            for await (const chunk of req) {
              total += chunk.length
              if (total > MAX_IMAGE_BYTES) {
                json(res, 413, { error: 'IMAGE_TOO_LARGE' })
                return
              }
              chunks.push(chunk)
            }
            const buffer = Buffer.concat(chunks)
            const mediaType = sniffMediaType(buffer)
            if (!mediaType) {
              json(res, 400, { error: 'BAD_IMAGE' })
              return
            }
            const ref = await ctx.attachments.saveImage({ data: buffer, mediaType, name: 'autovision-paste' })
            const signal = AbortSignal.timeout(DESCRIBE_TIMEOUT_MS)
            const text = await transcribeBlock(ctx, { attachment: ref }, {
              provider: cfg.defaultVisionModel.provider,
              model: cfg.defaultVisionModel.model,
              prompt: cfg.prompt,
            }, signal)
            json(res, 200, { text })
          } catch (error) {
            if (error && (error.name === 'TimeoutError' || error.code === 'ETIMEDOUT')) {
              json(res, 408, { error: 'TIMEOUT' })
              return
            }
            json(res, 500, { error: String(error?.message ?? error) })
          }
        },
      })
    })
  }
}

// Services this plugin needs, resolved by Cordis into the apply context.
// webServer stays out: it exists only under the web profile, and a
// required-but-missing service would fail the whole plugin on headless.
export const inject = ['llm', 'attachments']

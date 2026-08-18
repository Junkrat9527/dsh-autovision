# dsh-autovision — Design

This document explains how the plugin works against DeepSeek Harness's image
gate, and why it is built the way it is. It is aimed at maintainers and
contributors.

## Problem

DeepSeek Harness only lets a model *receive* images when that model declares
image input. The host reads `resolveModelInfo().inputModalities` at admission
time (image paste / model switch / send-message) and at stream time. Pure-text
models (`deepseek-*`, `glm-*`, …) declare `['text']`, so image messages are
rejected. There is no supported way to re-declare an existing adapter's model
(`DUPLICATE_ADAPTER`), and editing dsh core breaks `dsh upgrade`.

## Approach: a transparent twin + request-time redirect

For each pure-text model the plugin registers a **twin adapter**
`<provider>-autovision` via `ctx.llm.registerAdapter` (the same seam
`modlens` uses). The twin:

- `listModels` → `[]`. This is advisory only; `buildModelCatalog` filters
  empty groups, so the model picker stays clean (only your real models).
- `resolveModel` → upstream model info, with `inputModalities` extended to
  `['text', 'image']`.
- `stream()` → walks every image block in the wire messages (recursively,
  including image blocks nested inside `tool` results — dsh's own `read_image`
  nests one there), transcribes each via the configured vision model
  (LRU-cached, deduped), and forwards text upstream. The durable session log
  keeps the original image.

Requests are redirected with the official `agent/request` waterfall, `prepend`
so our override wins over host session selection:

```js
agent.ctx.on('agent/request', async (_p, next) => {
  const cfg = await next()
  if (isTwinId(cfg.provider)) return cfg
  if (twin.isWrapped(cfg.provider, cfg.model)) {
    return { ...cfg, provider: twin.twinFor(cfg.provider) }
  }
  return cfg
}, { prepend: true })
```

No `settings.yaml` is ever written, so there is no `NO_ADAPTER` on restart and
the plugin survives `dsh upgrade` without re-patching.

## Admission-time image declaration

`selectModel` and send-message admission read `selectionFor(agent).current`
(`picked` → last `requestHeader().config` → `defaultModelSelection()`) and
check its `inputModalities`. When the user manually picks a text-only model in
a session that already contains images, the switch is rejected even though our
redirect would route through the twin.

The plugin wraps the public `ctx.llm.resolveModelInfo`: for any model the twin
wraps, it appends `'image'` to the declared `inputModalities` at admission
time. The original resolver is exposed as
`llm.__autovisionOriginalResolveModelInfo` so the twin's `shouldWrap` guard can
still distinguish *natively* image-capable models. The wrap is purely
in-memory — no config, no core edit, survives restart.

## Agent-callable read-image tool

`autovision_read_image` is registered via `ctx.tools.register` with a raw
definition (no `@deepseek-ai/dsh-tools` import). Parameters: `file_path`
(required) and `prompt` (optional — the model writes its own per-task
instruction). `execute` reads the bytes, sniffs the media type,
`attachments.saveImage`s it, and reuses the same transcription path as paste,
targeting the configured vision model. Results are plain text (image bytes
never enter the text model's context) and prefixed `[图片识别结果]` so a
description that happens to start with "Error" is not misread as a failed
tool call. On headless profiles without a `tools` service the tool is skipped
and paste transcription still works.

## No built-in credentials

The recognition engine is whatever multimodal model the user configures as
`defaultVisionModel` (from dsh's own LLM providers, e.g. `opencode-go`,
`minimax-m3`). The plugin ships no API key, no relay URL, no third-party
endpoint, and makes no network calls of its own — it only drives
`ctx.llm.stream` on a provider the host already knows.

## Known limits

- A brand-new session whose very first message already contains an image is
  silently skipped (the default-selection admission has no request header to
  consult yet); sending one text message first activates redirect for the rest
  of the session.
- Images up to 5 MB (attachment-local default).
- Transcription latency is the vision model's latency (6–9 s for `minimax-m3`
  measured), mitigated by an LRU cache.
- The settings page may show one bare provider row (`<provider>-autovision`)
  with no address — cosmetic only.

## Extension points used

| dsh seam | purpose |
|---|---|
| `ctx.llm.registerAdapter` | twin registration |
| `agent/request` waterfall (`prepend`) | per-request redirect to the twin |
| `ctx.llm.resolveModelInfo` (wrapped) | admission-time image declaration |
| `ctx.tools.register` | `autovision_read_image` tool |
| `ctx.attachments.saveImage` | image bytes for transcription |
| `ctx.webServer` (optional) | `/autovision/*` routes under the web profile |

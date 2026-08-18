// Browser half of the dsh-autovision plugin (v2): image fidelity + auto text.
//
// v1 intercepted paste and pushed the transcription into the composer. v2 does
// the opposite: paste flows through dsh's native intake, so the picture shows
// as a real attachment — thumbnail in the composer rail, image block in the
// message — while the host twin route (`<provider>-autovision`) transparently
// swaps the image for text only on the wire to the text-only model. The user
// sees the image; the model sees words. No paste interception here anymore.
//
// This half only hosts the settings card: enable the auto mode, pick the
// default vision model that transcribes images for text-only models, and edit
// the recognition prompt.
//
// Hand-written in the lazy-CJS bundle protocol (window.__ModuleLoader__.load
// with a factory returning cordis-plugin exports), so no build step and no
// imports from dsh client packages — the same zero-dependency stance as the
// host half.

window.__ModuleLoader__.load({
  id: 'dsh-autovision',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    // ---- settings card -----------------------------------------------------

    var TEXT = {
      en: {
        title: 'Auto vision (dsh-autovision)',
        subtitle:
          'Image fidelity + auto text: pasted images stay real attachments (shown to you), while text-only models receive a transcription from the configured vision model. No extra groups appear in the model selector. Text-only models can also call the autonomous read-image tool on file paths.',
        autoMode: 'Auto mode',
        autoModeHint:
          'Text-only models automatically run through the recognition bridge. Images stay attachments in your view and reach the model as text only; no extra group shows in the model selector.',
        model: 'Default vision model',
        modelHint:
          'A multimodal model already configured in dsh. Used to transcribe images for text-only models.',
        none: '— none —',
        prompt: 'Recognition prompt',
        promptHint: 'Leave empty for the open-description default (the vision model organizes its own answer, like the see-image approach).',
        loading: 'loading…',
        save: 'Save',
        saving: 'saving…',
        saved: 'saved',
        discard: 'Discard',
        noModels: 'No image-capable models found. Configure a multimodal model in the LLM providers first.',
        noteOff: 'Auto mode is off. Images sent to text-only models will be rejected by the model image gate.',
      },
      zh: {
        title: '自动识图（dsh-autovision）',
        subtitle:
          '图片保真 + 自动转文本：粘贴的图片始终是真实附件（界面上你看到图片），纯文本模型在底层收到由默认识图模型转录的文本。纯文本模型运行中还可自主调用识图工具读取图片文件。',
        autoMode: '自动模式',
        autoModeHint:
          '纯文本模型自动走识别转换路由。图片在界面上保留为附件，发送给模型时只携带识别文本；模型选择器中不出现任何额外分组。',
        model: '默认识图模型',
        modelHint: '在 dsh 中已配置的多模态模型。纯文本模型的图片由它来识别。',
        none: '— 未选择 —',
        prompt: '识别提示词',
        promptHint: '留空使用开放描述默认提示词（识图模型看图自主组织内容，参考 see-image 思路）。',
        loading: '加载中…',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        discard: '放弃修改',
        noModels: '未找到可识图的多模态模型。请先在「LLM 供应商」里配置一个多模态模型。',
        noteOff: '自动模式已关闭：向纯文本模型发送图片会被模型图片门禁拒绝。',
      },
    }

    function labels() {
      var lang = (document.documentElement.lang || navigator.language || 'en').toLowerCase()
      return lang.indexOf('zh') === 0 ? TEXT.zh : TEXT.en
    }

    function modelValue(m) {
      return m ? m.provider + '::' + m.model : ''
    }

    function parseModelValue(value) {
      if (!value) return null
      var sep = value.indexOf('::')
      if (sep < 0) return null
      return { provider: value.slice(0, sep), model: value.slice(sep + 2) }
    }

    function nextDraft(summary) {
      return {
        enabled: summary.enabled !== false,
        defaultVisionModel: summary.defaultVisionModel,
        prompt: summary.prompt || '',
      }
    }

    function ConfigCard(react, ui) {
      var h = react.createElement
      var Input = ui.Input

      var chevron = (open) =>
        h(
          'svg',
          {
            width: 16,
            height: 16,
            viewBox: '0 0 16 16',
            style: {
              color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
              flex: 'none',
              transition: 'transform .16s',
              transform: open ? 'rotate(180deg)' : 'none',
            },
          },
          h('path', {
            d: 'M4 6l4 4 4-4',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.5,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        )

      return function AutovisionCard() {
        var t = labels()
        var openState = react.useState(false)
        var summaryState = react.useState(null)
        var draftState = react.useState(null)
        var noteState = react.useState('')
        var open = openState[0]
        var summary = summaryState[0]
        var draft = draftState[0]
        var note = noteState[0]

        var load = react.useCallback(() => {
          Promise.all([
            fetch('/autovision/config').then((r) => r.json()),
            fetch('/autovision/models').then((r) => r.json()),
          ])
            .then(([config, models]) => {
              var next = Object.assign({}, config, { models: models.models || [] })
              summaryState[1](next)
              draftState[1](nextDraft(next))
              noteState[1]('')
            })
            .catch((error) => {
              noteState[1](String(error.message ? error.message : error))
            })
        }, [])

        react.useEffect(() => {
          if (open && summary === null) load()
        }, [open, summary, load])

        var fieldRow = (label, control, key) =>
          h(
            'label',
            {
              key: key,
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
                padding: '12px 0',
                borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
              },
            },
            h('div', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary, inherit)' } }, label),
            control,
          )

        var hint = (text) =>
          h(
            'div',
            {
              style: {
                fontSize: '12px',
                color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
              },
            },
            text,
          )

        var body = null
        if (open) {
          if (summary === null || draft === null) {
            body = h(
              'div',
              {
                style: {
                  padding: '12px 0',
                  color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                  fontSize: '13px',
                },
              },
              note || t.loading,
            )
          } else {
            var models = summary.models || []
            var dirty =
              draft.enabled !== (summary.enabled !== false) ||
              modelValue(draft.defaultVisionModel) !== modelValue(summary.defaultVisionModel) ||
              draft.prompt !== (summary.prompt || '')

            var selectProps = (value, onChange) => ({
              value: value,
              onChange: onChange,
              style: {
                appearance: 'none',
                width: '100%',
                padding: '8px 12px',
                borderRadius: '8px',
                border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
                background: 'transparent',
                color: 'inherit',
                font: 'inherit',
                fontSize: '13px',
              },
            })

            var modelOptions = models.length
              ? models.map((m) =>
                  h(
                    'option',
                    { key: modelValue(m), value: modelValue(m) },
                    m.provider + ' / ' + m.model + (m.name && m.name !== m.model ? ' (' + m.name + ')' : ''),
                  ),
                )
              : [h('option', { key: 'none', value: '' }, t.none)]

            body = h(
              'div',
              null,
              fieldRow(
                h('span', null, t.autoMode, hint(t.autoModeHint)),
                h(
                  'label',
                  {
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      cursor: 'pointer',
                      fontSize: '13px',
                    },
                  },
                  h('input', {
                    type: 'checkbox',
                    checked: draft.enabled,
                    onChange: (event) => {
                      draftState[1](Object.assign({}, draft, { enabled: event.target.checked }))
                      noteState[1]('')
                    },
                    style: { width: '16px', height: '16px', accentColor: 'var(--dsw-alias-label-primary, currentColor)' },
                  }),
                  h('span', null, draft.enabled ? '开启' : '关闭'),
                ),
                draft.enabled ? null : hint(t.noteOff),
                'auto-mode',
              ),
              fieldRow(
                h('span', null, t.model, hint(t.modelHint)),
                h(
                  'select',
                  selectProps(modelValue(draft.defaultVisionModel), (event) => {
                    draftState[1](Object.assign({}, draft, { defaultVisionModel: parseModelValue(event.target.value) }))
                    noteState[1]('')
                  }),
                  models.length
                    ? [h('option', { key: '', value: '' }, t.none)].concat(modelOptions)
                    : modelOptions,
                ),
                'model',
              ),
              models.length === 0
                ? hint(t.noModels)
                : null,
              fieldRow(
                h('span', null, t.prompt, hint(t.promptHint)),
                h(Input, {
                  type: 'text',
                  value: draft.prompt,
                  placeholder: '（使用默认）',
                  onChange: (event) => {
                    draftState[1](Object.assign({}, draft, { prompt: event.target.value }))
                    noteState[1]('')
                  },
                }),
                'prompt',
              ),
              h(
                'div',
                {
                  key: 'footer',
                  style: {
                    borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
                    display: 'flex',
                    justifyContent: 'flex-end',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '12px 0 4px',
                  },
                },
                h(
                  'span',
                  {
                    role: 'status',
                    style: {
                      marginRight: 'auto',
                      fontSize: '12px',
                      color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                    },
                  },
                  note,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    disabled: !dirty || note === t.saving,
                    onClick: () => {
                      draftState[1](nextDraft(summary))
                      noteState[1]('')
                    },
                    style: {
                      appearance: 'none',
                      font: 'inherit',
                      fontSize: '13px',
                      lineHeight: 1.5,
                      cursor: dirty ? 'pointer' : 'default',
                      border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
                      borderRadius: '8px',
                      padding: '5px 14px',
                      background: 'none',
                      color: 'var(--dsw-alias-label-secondary, inherit)',
                      opacity: dirty ? 1 : 0.4,
                    },
                  },
                  t.discard,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    disabled: !dirty || note === t.saving,
                    onClick: () => {
                      noteState[1](t.saving)
                      fetch('/autovision/config', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({
                          enabled: draft.enabled,
                          defaultVisionModel: draft.defaultVisionModel,
                          prompt: draft.prompt,
                        }),
                      })
                        .then((r) =>
                          r.json().then((body) => {
                            if (!r.ok) throw new Error(body.error || 'save failed')
                            return body
                          }),
                        )
                        .then((next) => {
                          var updated = Object.assign({}, next, { models: summary.models })
                          summaryState[1](updated)
                          draftState[1](nextDraft(updated))
                          noteState[1](t.saved)
                        })
                        .catch((error) => {
                          noteState[1](String(error.message ? error.message : error))
                        })
                    },
                    style: {
                      appearance: 'none',
                      font: 'inherit',
                      fontSize: '13px',
                      lineHeight: 1.5,
                      cursor: dirty ? 'pointer' : 'default',
                      border: '1px solid transparent',
                      borderRadius: '8px',
                      padding: '5px 14px',
                      background: 'var(--dsw-alias-label-primary, currentColor)',
                      color: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.05))',
                      opacity: dirty ? 1 : 0.4,
                    },
                  },
                  t.save,
                ),
              ),
            )
          }
        }

        return h(
          'div',
          {
            style: {
              border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
              background: open
                ? 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.10))'
                : 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.05))',
              borderRadius: '12px',
              transition: 'border-color .16s, background .16s',
            },
          },
          h(
            'button',
            {
              type: 'button',
              'aria-expanded': open,
              onClick: () => {
                openState[1](!open)
              },
              style: {
                appearance: 'none',
                width: '100%',
                font: 'inherit',
                color: 'inherit',
                textAlign: 'left',
                cursor: 'pointer',
                background: 'none',
                border: 0,
                borderRadius: '12px',
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '14px 16px',
              },
            },
            h(
              'div',
              { style: { flex: 1, minWidth: 0 } },
              h('div', { style: { fontSize: '14px', fontWeight: 600 } }, t.title),
              h(
                'div',
                {
                  style: {
                    color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                    fontSize: '13px',
                    lineHeight: 1.5,
                  },
                },
                t.subtitle,
              ),
            ),
            chevron(open),
          ),
          open ? h('div', { style: { margin: '0 16px', paddingBottom: '8px' } }, body) : null,
        )
      }
    }

    function registerCard(ctx) {
      // Reaching for an undeclared service throws in cordis, so the optional
      // dependency rides a scoped ctx.inject: the closure runs where slots
      // exists and never runs where it does not, exactly as the host half
      // takes webServer.
      if (typeof ctx.inject !== 'function') return
      ctx.inject(['slots'], (scope) => {
        // Any response at all proves the route exists; only a 404 or a
        // network failure reads as absent.
        fetch('/autovision/config')
          .then((response) => {
            if (response.status === 404) return
            try {
              mountCard(scope)
            } catch (error) {
              console.error(`[dsh-autovision] settings card skipped: ${error}`)
            }
          })
          .catch(() => {})
      })
    }

    function mountCard(ctx) {
      var react
      try {
        react = require('react')
      } catch (error) {
        console.error(`[dsh-autovision] settings card skipped: ${error}`)
        return
      }
      var ui = require('@deepseek-ai/dsh-client-ui-primitives')
      var Card = ConfigCard(react, ui)
      ctx.slots.inject('settings.plugin.item', function* () {
        yield ctx.slots.register({ name: 'settings.plugin.item', id: 'autovision', order: 35 }, Card)
      })
    }

    function apply(ctx) {
      registerCard(ctx)
    }

    exports.apply = apply
    // `slots` is optional, so it is not required here: registerCard checks.
    exports.inject = []
    return module.exports
  },
})

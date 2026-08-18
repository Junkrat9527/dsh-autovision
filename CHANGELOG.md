# Changelog

All notable changes to dsh-autovision are documented here. The project follows
[Keep a Changelog](https://keepachangelog.com/) and uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-08-18

Open-source first release. Contains the v2 / v2.1 / v2.1.1 / v3 feature set.

### Added

- **Transparent twin routing** — every pure-text model gets a `<provider>-autovision`
  twin registered at runtime that declares image input; `agent/request` auto-redirects
  each request so you never switch models or edit `settings.yaml`.
- **Paste → text automatically** — images attached in the composer are transcribed by
  your configured vision model and injected into the text model's context; the original
  image stays visible in the UI and the durable log keeps it.
- **Clean model selector** — twin `listModels` returns `[]`, so the picker shows only
  your real models.
- **`autovision_read_image` tool** — the model can actively read an image file during a
  run with its own per-task prompt.
- **No built-in credentials** — recognition uses whatever multimodal model you configure
  as the default vision model; no API key, no relay, nothing hardcoded.
- **Runtime `resolveModelInfo` patch** — lets you manually switch to any wrapped text
  model mid-session without rejection.

### Fixed

- v2.1.1: manual switch to a text model in an image session was rejected by admission
  (`selectModel`/send admission read `inputModalities`); the runtime patch now adds the
  image declaration for wrapped models. Twin `shouldWrap` guard switched to the exposed
  original resolver to avoid a "twin no longer applies" loop.
- v3: a transcription whose first line is "Error" was misread as a failed tool call —
  tool results are now prefixed with `[图片识别结果]`.
- v3: the old fixed OCR prompt in `config.json` overrode the new open-ended default —
  defaults updated to an open-ended description prompt (see-image style).

### Known limits

- A brand-new session whose very first message already contains an image is silently
  skipped; send one text message first.
- Images up to 5 MB (attachment-local default).

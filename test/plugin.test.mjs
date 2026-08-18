import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject } from '../index.js'

test('module exports apply and inject', () => {
  assert.equal(typeof apply, 'function')
  assert.ok(Array.isArray(inject), 'inject should be an array')
  assert.ok(inject.includes('llm'), 'needs llm service')
  assert.ok(inject.includes('attachments'), 'needs attachments service')
})

test('apply tolerates a host without optional services', async () => {
  // A minimal context with only the required services present; optional ones
  // (webServer, tools) are absent, which must not crash apply.
  const ctx = {
    llm: { registerAdapter() {}, listProviders: async () => [], listModels: async () => [] },
    attachments: { saveImage: async () => ({}) },
    on() {},
  }
  const cfg = { enabled: true, defaultVisionModel: null, prompt: '', targetProviders: [] }
  await apply(ctx, cfg)
  assert.ok(true, 'apply completed without throwing on a minimal host')
})

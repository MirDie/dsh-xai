import { describe, expect, it } from 'vitest'
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai'
import { preferredXaiOAuthModel } from '../src/adapter.ts'
import { DEFAULT_XAI_OAUTH_MODEL } from '../src/ids.ts'

describe('preferredXaiOAuthModel', () => {
  it('prefers grok-4.6 when the catalog ships it, otherwise grok-4.5', () => {
    const ids = new Set(xaiProvider().getModels().map(model => model.id))
    const preferred = preferredXaiOAuthModel()
    if (ids.has('grok-4.6')) expect(preferred).toBe('grok-4.6')
    else if (ids.has(DEFAULT_XAI_OAUTH_MODEL)) expect(preferred).toBe(DEFAULT_XAI_OAUTH_MODEL)
    else expect(ids.has(preferred)).toBe(true)
  })

  it('exposes the xAI catalog on the pi-ai provider, not the harness route id', () => {
    const provider = xaiProvider()
    expect(provider.id).toBe('xai')
    expect(provider.getModels().length).toBeGreaterThan(0)
  })
})

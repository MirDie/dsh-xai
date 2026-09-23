import { describe, expect, it } from 'vitest'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai'
import { createXaiOAuthAdapter, preferredXaiOAuthModel } from '../src/adapter.ts'
import { materializeLiveModel } from '../src/catalog.ts'
import { DEFAULT_XAI_OAUTH_MODEL, XAI_OAUTH_ROUTE } from '../src/ids.ts'
import { XaiOAuthSession } from '../src/session.ts'

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

describe('XaiOAuthSession.provider', () => {
  it('registers models under the harness route so the picker can find them', async () => {
    const { createModels } = await import('@earendil-works/pi-ai')
    const { XAI_OAUTH_ROUTE } = await import('../src/ids.ts')
    const { XaiOAuthSession } = await import('../src/session.ts')
    const session = new XaiOAuthSession()
    const provider = session.provider()
    expect(provider.id).toBe(XAI_OAUTH_ROUTE)
    const models = createModels()
    models.setProvider(provider)
    const listed = models.getModels(XAI_OAUTH_ROUTE)
    expect(listed.length).toBeGreaterThan(0)
    expect(listed.every(model => model.provider === XAI_OAUTH_ROUTE)).toBe(true)
  })
})

describe('createXaiOAuthAdapter reasoning', () => {
  it('omits a profile default when Config.reasoning is unset', async () => {
    const adapter = createXaiOAuthAdapter(new XaiOAuthSession(), () => undefined)
    const info = await adapter.resolveModel(XAI_OAUTH_ROUTE, DEFAULT_XAI_OAUTH_MODEL)
    expect(info.reasoning?.defaultEffort).toBeUndefined()
  })

  it('pins high on the xai-oauth profile when Config sets it', async () => {
    const adapter = createXaiOAuthAdapter(new XaiOAuthSession(), () => undefined, 'high')
    const info = await adapter.resolveModel(XAI_OAUTH_ROUTE, DEFAULT_XAI_OAUTH_MODEL)
    expect(info.reasoning?.defaultEffort).toBe('high')
  })

  it('treats high as a supported level for grok-4.6', () => {
    const grok46 = materializeLiveModel('grok-4.6')
    expect(getSupportedThinkingLevels(grok46)).toContain('high')
  })
})

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai'
import { XAI_PI_PROVIDER } from '../src/ids.ts'
import { XaiOAuthSession } from '../src/session.ts'
import { XaiOAuthCredentialStore } from '../src/store.ts'

async function sessionWithStore(): Promise<XaiOAuthSession> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-xai-session-'))
  return new XaiOAuthSession(
    new XaiOAuthCredentialStore(join(dir, 'auth.json')),
    undefined,
    { cacheFile: join(dir, 'models.json') },
  )
}

describe('XaiOAuthSession.accessToken', () => {
  it('does not fall back to XAI_API_KEY when unsigned', async () => {
    const previous = process.env['XAI_API_KEY']
    process.env['XAI_API_KEY'] = 'xai-env-should-not-be-used'
    try {
      const session = await sessionWithStore()
      expect(await session.accessToken()).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env['XAI_API_KEY']
      else process.env['XAI_API_KEY'] = previous
    }
  })
})

describe('XaiOAuthSession.setSelectedModels', () => {
  it('keeps only ids that exist in the available catalog', async () => {
    const session = await sessionWithStore()
    const known = session.availableModels()[0]?.id
    expect(known).toBeDefined()
    await session.setSelectedModels([known!, 'not-a-real-model', ''])
    expect(session.selectedModelIds()).toEqual([known])
  })
})

describe('XaiOAuthSession.refreshLiveCatalog', () => {
  afterEach(() => {
    // restored in each test
  })

  it('ignores a late listing after logout', async () => {
    const session = await sessionWithStore()
    await session.store.modify(XAI_PI_PROVIDER, async () => ({
      type: 'oauth',
      access: 'access-token',
      refresh: 'refresh-token',
      expires: Date.now() + 60_000,
    }))
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const original = globalThis.fetch
    globalThis.fetch = (async () => {
      await gate
      return new Response(JSON.stringify({ data: [{ id: 'grok-4.5' }] }), { status: 200 })
    }) as typeof fetch
    try {
      const pending = session.refreshLiveCatalog()
      await session.logout()
      release()
      await pending
      expect(session.catalogSource).toBe('fallback')
      expect(session.availableModels().map(model => model.id)).toEqual(
        xaiProvider().getModels().map(model => model.id),
      )
    } finally {
      globalThis.fetch = original
    }
  })
})

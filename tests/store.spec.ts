import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { XAI_PI_PROVIDER } from '../src/ids.ts'
import { XaiOAuthCredentialStore } from '../src/store.ts'

const files: string[] = []

afterEach(async () => {
  files.length = 0
})

async function tempStore(): Promise<XaiOAuthCredentialStore> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-xai-'))
  const filename = join(dir, 'auth.json')
  files.push(filename)
  return new XaiOAuthCredentialStore(filename)
}

describe('XaiOAuthCredentialStore', () => {
  it('round-trips an oauth credential', async () => {
    const store = await tempStore()
    const written = await store.modify(XAI_PI_PROVIDER, async () => ({
      type: 'oauth',
      access: 'access-token',
      refresh: 'refresh-token',
      expires: 1_700_000_000_000,
    }))
    expect(written).toMatchObject({ type: 'oauth', access: 'access-token', refresh: 'refresh-token' })
    const read = await store.read(XAI_PI_PROVIDER)
    expect(read).toEqual(written)
    expect(await store.list()).toEqual([{ providerId: XAI_PI_PROVIDER, type: 'oauth' }])
    const text = await readFile(store.filename, 'utf8')
    expect(text).not.toContain('XAI_API_KEY')
    expect(JSON.parse(text).version).toBe(1)
  })

  it('ignores other provider ids on read and refuses them on write', async () => {
    const store = await tempStore()
    await store.modify(XAI_PI_PROVIDER, async () => ({
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: 1,
    }))
    expect(await store.read('openai-codex')).toBeUndefined()
    await expect(store.modify('openai-codex', async current => current)).rejects.toThrow(/does not own/)
  })

  it('rejects an unsupported document version', async () => {
    const store = await tempStore()
    await writeFile(store.filename, `${JSON.stringify({
      version: 99,
      credential: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 },
    })}\n`)
    await expect(store.read(XAI_PI_PROVIDER)).rejects.toThrow(/unsupported auth format version/)
  })

  it('rejects unknown credential fields', async () => {
    const store = await tempStore()
    await writeFile(store.filename, `${JSON.stringify({
      version: 1,
      credential: { type: 'oauth', access: 'a', refresh: 'r', expires: 1, leak: 'nope' },
    })}\n`)
    await expect(store.read(XAI_PI_PROVIDER)).rejects.toThrow(/unknown field/)
  })

  it('deletes only the xAI credential', async () => {
    const store = await tempStore()
    await store.modify(XAI_PI_PROVIDER, async () => ({
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: 1,
    }))
    await store.delete(XAI_PI_PROVIDER)
    expect(await store.read(XAI_PI_PROVIDER)).toBeUndefined()
    expect(await store.list()).toEqual([])
  })
})

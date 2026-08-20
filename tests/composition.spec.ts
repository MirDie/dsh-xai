import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('bundle composition', () => {
  it('inserts the xai-oauth host plugin and a Grok default model', async () => {
    const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('provider: xai-oauth')
    expect(patch).toMatch(/model: grok-4\./)
    expect(patch).toContain('id: llm-xai-oauth')
    expect(patch).toContain('name: dsh-xai')
  })

  it('declares a dsh bundle and web client half', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      name: string
      dsh: { bundle: { patch: string }; client: { platform: string } }
    }
    expect(manifest.name).toBe('dsh-xai')
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh.client.platform).toBe('web')
  })
})

describe('Config', () => {
  it('accepts an empty object so omission keeps the provider default', () => {
    expect(Config({})).toEqual({})
  })

  it('accepts high as a reasoning pin', () => {
    expect(Config({ reasoning: 'high' })).toEqual({ reasoning: 'high' })
  })

  it('rejects an unknown reasoning level', () => {
    expect(() => Config({ reasoning: 'nope' as never })).toThrow()
  })
})

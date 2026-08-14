/**
 * Shared OAuth store + live catalog for the host plugin and CLI.
 * @module dsh-xai/session
 */

import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createModels } from '@earendil-works/pi-ai'
import type { Api, Model, MutableModels, Provider } from '@earendil-works/pi-ai'
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  fetchLiveModelIds,
  mergeLiveCatalog,
  type CatalogSource,
} from './catalog.ts'
import { XAI_PI_PROVIDER } from './ids.ts'
import { XaiOAuthCredentialStore } from './store.ts'

const MODELS_CACHE_VERSION = 1
const MODELS_CACHE_FILENAME = '.xai-oauth-models.json'

interface ModelsCacheDocument {
  version: typeof MODELS_CACHE_VERSION
  ids: string[]
  fetchedAt: number
}

function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

function modelsCachePath(dshHome?: string): string {
  return resolve(join(resolveDshHome(dshHome), MODELS_CACHE_FILENAME))
}

function parseCache(text: string): string[] | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const document = value as Record<string, unknown>
  if (document['version'] !== MODELS_CACHE_VERSION) return undefined
  if (!Array.isArray(document['ids'])) return undefined
  const ids = document['ids'].filter((id): id is string => typeof id === 'string' && id.length > 0)
  return ids.length === 0 ? undefined : ids
}

function requestProvider(provider: Provider): Provider {
  return {
    ...provider,
    auth: {
      ...provider.auth,
      apiKey: {
        name: 'xAI Grok OAuth bearer token',
        async resolve({ credential }) {
          const apiKey = credential?.key
          return apiKey === undefined || apiKey.length === 0
            ? undefined
            : { auth: { apiKey }, source: 'OAuth' }
        },
      },
    },
  }
}

/** One process-local owner of the credential and the account model list. */
export class XaiOAuthSession {
  readonly store: XaiOAuthCredentialStore
  readonly models: MutableModels
  private readonly baseline: Provider
  private liveIds: string[] | undefined
  private source: CatalogSource = 'fallback'
  private listingError: string | undefined
  private readonly cacheFile: string

  constructor(store: XaiOAuthCredentialStore = new XaiOAuthCredentialStore()) {
    this.store = store
    this.cacheFile = modelsCachePath()
    this.baseline = xaiProvider()
    this.models = createModels({ credentials: store })
    this.models.setProvider(this.baseline)
  }

  /** Secret-free listing diagnostic from the last refresh. */
  get catalogError(): string | undefined {
    return this.listingError
  }

  get catalogSource(): CatalogSource {
    return this.source
  }

  visibleModels(): Model<Api>[] {
    return mergeLiveCatalog(this.baseline.getModels(), this.liveIds)
  }

  /** Provider whose getModels() reflects the current live/cache/fallback list. */
  provider(): Provider {
    return {
      ...requestProvider(this.baseline),
      getModels: () => this.visibleModels(),
    }
  }

  async loadCachedCatalog(): Promise<void> {
    try {
      const ids = parseCache(await readFile(this.cacheFile, 'utf8'))
      if (ids === undefined) return
      this.liveIds = ids
      this.source = 'cache'
    } catch (error) {
      if (!isENOENT(error)) throw error
    }
  }

  async refreshLiveCatalog(signal?: AbortSignal): Promise<void> {
    const auth = await this.models.getAuth(XAI_PI_PROVIDER)
    const access = auth?.auth.apiKey
    if (access === undefined || access.length === 0) {
      this.listingError = undefined
      return
    }
    try {
      const ids = await fetchLiveModelIds(access, signal)
      this.liveIds = ids
      this.source = 'live'
      this.listingError = undefined
      await this.writeCache(ids)
    } catch (error) {
      this.listingError = error instanceof Error ? error.message : String(error)
      if (this.liveIds === undefined) this.source = 'fallback'
    }
  }

  async logout(): Promise<void> {
    await this.store.delete(XAI_PI_PROVIDER)
    this.liveIds = undefined
    this.source = 'fallback'
    this.listingError = undefined
    await mkdir(dirname(this.cacheFile), { recursive: true, mode: 0o700 })
    await rm(this.cacheFile, { force: true })
  }

  private async writeCache(ids: readonly string[]): Promise<void> {
    const document: ModelsCacheDocument = {
      version: MODELS_CACHE_VERSION,
      ids: [...ids],
      fetchedAt: Date.now(),
    }
    await mkdir(dirname(this.cacheFile), { recursive: true, mode: 0o700 })
    await writeFileAtomic(this.cacheFile, `${JSON.stringify(document)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    })
  }
}



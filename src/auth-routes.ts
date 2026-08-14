/** Same-origin Web settings routes for xAI Grok OAuth. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AuthEvent, AuthPrompt } from '@earendil-works/pi-ai'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { loginXaiOAuthSession, importXaiOAuthSession, xaiOAuthAuthStatus } from './auth.ts'
import type { CatalogSource } from './catalog.ts'
import { probeGrokAuth } from './grok-import.ts'
import { safeMessage } from './redact.ts'
import type { XaiOAuthSession } from './session.ts'

export const XAI_OAUTH_AUTH_STATUS_PATH = '/plugins/dsh-xai/auth/status'
export const XAI_OAUTH_AUTH_LOGIN_PATH = '/plugins/dsh-xai/auth/login'
export const XAI_OAUTH_AUTH_IMPORT_PATH = '/plugins/dsh-xai/auth/import'
export const XAI_OAUTH_AUTH_LOGOUT_PATH = '/plugins/dsh-xai/auth/logout'

export type XaiOAuthWebAuthStatus =
  | { status: 'signed-out'; grokImportAvailable: boolean }
  | { status: 'signing-in'; url?: string; userCode?: string; grokImportAvailable: boolean }
  | {
    status: 'signed-in'
    models: string[]
    catalogSource: CatalogSource
    catalogError?: string
    grokImportAvailable: boolean
  }
  | { status: 'error'; message: string; grokImportAvailable: boolean }

export interface LoginChallenge {
  url: string
  userCode?: string
}

function waitForPromptAbort(prompt: AuthPrompt): Promise<string> {
  const signal = prompt.signal
  if (signal === undefined) return new Promise<string>(() => {})
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<string>((_resolve, reject) => {
    signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
  })
}

async function grokImportAvailable(): Promise<boolean> {
  return (await probeGrokAuth()).available
}

/** One lifecycle owner for the device-code poller, challenge, and public status. */
export class XaiOAuthWebAuth {
  private state: XaiOAuthWebAuthStatus = { status: 'signed-out', grokImportAvailable: false }
  private operation: Promise<void> | undefined
  private cancellation: AbortController | undefined
  private challenge: LoginChallenge | undefined
  private challengeWaiters: Array<{ resolve(value: LoginChallenge): void; reject(error: unknown): void }> = []

  constructor(private readonly session: XaiOAuthSession) {}

  async status(): Promise<XaiOAuthWebAuthStatus> {
    if (this.operation !== undefined) return this.state
    if (this.state.status === 'error') {
      return { ...this.state, grokImportAvailable: await grokImportAvailable() }
    }
    return this.readStoredStatus()
  }

  async signIn(): Promise<LoginChallenge> {
    if (this.operation === undefined) this.start()
    if (this.challenge !== undefined) return this.challenge
    return new Promise<LoginChallenge>((resolve, reject) => {
      this.challengeWaiters.push({ resolve, reject })
    })
  }

  async importGrok(): Promise<void> {
    this.cancellation?.abort(new Error('xAI Grok sign-in cancelled'))
    await this.operation?.catch(() => undefined)
    await importXaiOAuthSession(this.session)
    this.challenge = undefined
    this.state = await this.readStoredStatus()
  }

  async signOut(): Promise<void> {
    this.cancellation?.abort(new Error('xAI Grok sign-in cancelled'))
    await this.operation?.catch(() => undefined)
    await this.session.logout()
    this.state = { status: 'signed-out', grokImportAvailable: await grokImportAvailable() }
    this.challenge = undefined
  }

  async dispose(): Promise<void> {
    this.cancellation?.abort(new Error('xAI Grok plugin disposed'))
    await this.operation?.catch(() => undefined)
  }

  private start(): void {
    const cancellation = new AbortController()
    this.cancellation = cancellation
    this.challenge = undefined
    this.state = { status: 'signing-in', grokImportAvailable: false }
    this.operation = loginXaiOAuthSession({
      signal: cancellation.signal,
      prompt: prompt => prompt.type === 'select'
        ? Promise.resolve(prompt.options.some(option => option.id === 'oauth') ? 'oauth' : prompt.options[0]?.id ?? 'oauth')
        : waitForPromptAbort(prompt),
      notify: event => { this.onEvent(event) },
    }, this.session).then(
      async () => {
        this.state = await this.readStoredStatus()
      },
      (error: unknown) => {
        this.rejectChallenge(error)
        this.state = { status: 'error', message: safeMessage(error), grokImportAvailable: false }
      },
    ).finally(() => {
      this.operation = undefined
      this.cancellation = undefined
    })
  }

  private onEvent(event: AuthEvent): void {
    if (event.type === 'device_code') {
      this.acceptChallenge({
        url: event.verificationUri,
        ...event.userCode.length > 0 ? { userCode: event.userCode } : {},
      })
      return
    }
    if (event.type === 'auth_url') {
      this.acceptChallenge({ url: event.url })
    }
  }

  private acceptChallenge(challenge: LoginChallenge): void {
    try {
      const url = new URL(challenge.url)
      if (url.protocol !== 'https:') {
        const error = new Error('xAI returned an unsafe authorization URL')
        this.cancellation?.abort(error)
        this.rejectChallenge(error)
        return
      }
    } catch {
      const error = new Error('xAI returned an invalid authorization URL')
      this.cancellation?.abort(error)
      this.rejectChallenge(error)
      return
    }
    this.challenge = challenge
    this.state = {
      status: 'signing-in',
      url: challenge.url,
      grokImportAvailable: false,
      ...challenge.userCode === undefined ? {} : { userCode: challenge.userCode },
    }
    for (const waiter of this.challengeWaiters.splice(0)) waiter.resolve(challenge)
  }

  private async readStoredStatus(): Promise<XaiOAuthWebAuthStatus> {
    const [stored, grok] = await Promise.all([xaiOAuthAuthStatus(this.session.store), grokImportAvailable()])
    if (!stored.authenticated) return { status: 'signed-out', grokImportAvailable: grok }
    return {
      status: 'signed-in',
      models: this.session.visibleModels().map(model => model.id),
      catalogSource: this.session.catalogSource,
      grokImportAvailable: grok,
      ...this.session.catalogError === undefined ? {} : { catalogError: this.session.catalogError },
    }
  }

  private rejectChallenge(error: unknown): void {
    for (const waiter of this.challengeWaiters.splice(0)) waiter.reject(error)
  }
}

function trustedRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const host = req.headers.host
  if (host === undefined) return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === new URL(`http://${host}`).host
  } catch {
    return false
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

/** Register the plugin-owned OAuth routes when the Web server is composed. */
export function registerXaiOAuthAuthRoutes(
  ctx: Context,
  session: XaiOAuthSession,
): void {
  const auth = new XaiOAuthWebAuth(session)
  ctx.effect(() => {
    const routes = [
      ctx.webServer.register({
        kind: 'exact',
        path: XAI_OAUTH_AUTH_STATUS_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
          if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
          json(res, 200, await auth.status())
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: XAI_OAUTH_AUTH_LOGIN_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
          try {
            json(res, 200, await auth.signIn())
          } catch (error: unknown) {
            json(res, 500, { error: safeMessage(error) })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: XAI_OAUTH_AUTH_IMPORT_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
          try {
            await auth.importGrok()
            json(res, 200, await auth.status())
          } catch (error: unknown) {
            json(res, 500, { error: safeMessage(error) })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: XAI_OAUTH_AUTH_LOGOUT_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
          await auth.signOut()
          json(res, 200, { ok: true })
        },
      }),
    ]
    return async () => {
      for (const dispose of routes) dispose()
      await auth.dispose()
    }
  }, 'dsh-xai: Web OAuth routes')
}

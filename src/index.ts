/**
 * Optional xAI SuperGrok / X Premium bundle with OAuth, Grok models,
 * and browser account settings.
 * @module dsh-xai
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-llm'
import { createXaiOAuthAdapter } from './adapter.ts'
import { registerXaiOAuthAuthRoutes } from './auth-routes.ts'
import { XAI_OAUTH_ROUTE } from './ids.ts'
import { XaiOAuthSession } from './session.ts'
import { XaiOAuthCredentialStore } from './store.ts'

export { createXaiOAuthAdapter, preferredXaiOAuthModel } from './adapter.ts'
export {
  importXaiOAuthFromGrok,
  importXaiOAuthSession,
  loginXaiOAuth,
  loginXaiOAuthSession,
  logoutXaiOAuth,
  xaiOAuthAuthStatus,
} from './auth.ts'
export type { XaiOAuthAuthStatus } from './auth.ts'
export {
  registerXaiOAuthAuthRoutes,
  XAI_OAUTH_AUTH_IMPORT_PATH,
  XAI_OAUTH_AUTH_LOGIN_PATH,
  XAI_OAUTH_AUTH_LOGOUT_PATH,
  XAI_OAUTH_AUTH_MODELS_PATH,
  XAI_OAUTH_AUTH_STATUS_PATH,
} from './auth-routes.ts'
export type { LoginChallenge, XaiOAuthWebAuthStatus } from './auth-routes.ts'
export {
  extractModelIds,
  fetchLiveModelIds,
  isSelectableChatModel,
  materializeLiveModel,
  mergeLiveCatalog,
  preferredXaiOAuthModelFrom,
  XAI_MODELS_URL,
} from './catalog.ts'
export type { CatalogSource } from './catalog.ts'
export { grokAuthPath, importGrokAuth, parseGrokAuthDocument, probeGrokAuth } from './grok-import.ts'
export type { GrokImportProbe } from './grok-import.ts'
export {
  DEFAULT_XAI_OAUTH_MODEL,
  XAI_OAUTH_AUTH_FILENAME,
  XAI_OAUTH_ROUTE,
  XAI_OAUTH_STREAM_IDLE_TIMEOUT_MS,
  XAI_PI_PROVIDER,
} from './ids.ts'
export { safeMessage } from './redact.ts'
export {
  assertSafeAuthorizationUrl,
  isLoopbackHost,
  isTerminalOAuthFailure,
  trustedRequest,
  XAI_AUTH_HOSTS,
} from './trust.ts'
export { XaiOAuthSession } from './session.ts'
export { XaiOAuthCredentialStore, xaiOAuthAuthPath } from './store.ts'

/** Stable Cordis plugin name. */
export const name = 'llm-xai-oauth'

/** LLM registry required before the subscription route can register. */
export const inject = ['llm']

/** Reserved for later knobs; the first release has no tunable fields. */
export interface Config {}

export const Config: z<Config> = z.object({})

/**
 * Register the `xai-oauth` LLM route with a provider-native OAuth store.
 * @param ctx - plugin context carrying the LLM registry plus optional web server.
 */
export function apply(ctx: Context, _config: Config): void {
  const session = new XaiOAuthSession(new XaiOAuthCredentialStore(), () => {
    ctx.emit('llm/adapters-updated')
  })
  void session.loadCachedCatalog()
    .then(() => session.refreshLiveCatalog())
    .catch(() => undefined)
  ctx.llm.registerAdapter(
    [XAI_OAUTH_ROUTE],
    createXaiOAuthAdapter(session, () => ctx.get('attachments')),
  )
  ctx.inject(['webServer'], webCtx => registerXaiOAuthAuthRoutes(webCtx, session))
}

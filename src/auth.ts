/**
 * xAI OAuth orchestration shared by the plugin and standalone launcher.
 * @module dsh-xai/auth
 */

import { createModels } from '@earendil-works/pi-ai'
import type { AuthInteraction } from '@earendil-works/pi-ai'
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai'
import { importGrokAuth } from './grok-import.ts'
import { XAI_PI_PROVIDER } from './ids.ts'
import type { XaiOAuthSession } from './session.ts'
import { XaiOAuthCredentialStore } from './store.ts'

/** Non-secret login state shown by the launcher. */
export interface XaiOAuthAuthStatus {
  authenticated: boolean
  expiresAt?: Date
}

/** Complete provider-native OAuth and persist the resulting credential. */
export async function loginXaiOAuth(
  interaction: AuthInteraction,
  store: XaiOAuthCredentialStore = new XaiOAuthCredentialStore(),
): Promise<void> {
  const models = createModels({ credentials: store })
  models.setProvider(xaiProvider())
  await models.login(XAI_PI_PROVIDER, 'oauth', interaction)
}

/** Copy ~/.grok/auth.json into the dsh store. Does not modify the Grok file. */
export async function importXaiOAuthFromGrok(
  store: XaiOAuthCredentialStore = new XaiOAuthCredentialStore(),
  filename?: string,
): Promise<void> {
  await importGrokAuth(store, filename)
}

/** Remove the stored xAI OAuth credential. */
export async function logoutXaiOAuth(
  store: XaiOAuthCredentialStore = new XaiOAuthCredentialStore(),
): Promise<void> {
  await store.delete(XAI_PI_PROVIDER)
}

/** Read non-secret login state without refreshing the token. */
export async function xaiOAuthAuthStatus(
  store: XaiOAuthCredentialStore = new XaiOAuthCredentialStore(),
): Promise<XaiOAuthAuthStatus> {
  const credential = await store.read(XAI_PI_PROVIDER)
  return credential?.type === 'oauth'
    ? { authenticated: true, expiresAt: new Date(credential.expires) }
    : { authenticated: false }
}

/** Login then refresh the account model list when a session is available. */
export async function loginXaiOAuthSession(
  interaction: AuthInteraction,
  session: XaiOAuthSession,
): Promise<void> {
  await loginXaiOAuth(interaction, session.store)
  await session.refreshLiveCatalog()
}

export async function importXaiOAuthSession(
  session: XaiOAuthSession,
  filename?: string,
): Promise<void> {
  await importXaiOAuthFromGrok(session.store, filename)
  await session.refreshLiveCatalog()
}

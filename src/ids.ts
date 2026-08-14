/** pi-ai provider id used by login, refresh, and the credential store. */
export const XAI_PI_PROVIDER = 'xai'

/** Harness LLM route. Distinct from the catalog `xai` API-key route. */
export const XAI_OAUTH_ROUTE = 'xai-oauth'

/** Basename of the OAuth document inside the Harness home. */
export const XAI_OAUTH_AUTH_FILENAME = '.xai-oauth-auth.json'

/** Fallback model when the installed pi-ai catalog has no grok-4.6. */
export const DEFAULT_XAI_OAUTH_MODEL = 'grok-4.5'

/** Provider idle ceiling used by the composite route. */
export const XAI_OAUTH_STREAM_IDLE_TIMEOUT_MS = 300_000

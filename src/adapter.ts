/** xAI subscription adapter assembled from public dsh-llm-pi-ai extension points. */

import { LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import { preferredXaiOAuthModelFrom } from './catalog.ts'
import {
  XAI_OAUTH_ROUTE,
  XAI_OAUTH_STREAM_IDLE_TIMEOUT_MS,
  XAI_PI_PROVIDER,
} from './ids.ts'
import type { XaiOAuthSession } from './session.ts'
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai'

/** Prefer grok-4.6 when the current (live or installed) list has it. */
export function preferredXaiOAuthModel(
  models: readonly { id: string }[] = xaiProvider().getModels(),
): string {
  return preferredXaiOAuthModelFrom(models)
}

/**
 * Create the SuperGrok adapter without a dsh fork.
 * The public pi-ai adapter owns streaming, tools, reasoning, and compaction;
 * this plugin supplies a refreshable OAuth token and an account model list.
 */
export function createXaiOAuthAdapter(
  session: XaiOAuthSession,
  resolveAttachments: () => AttachmentStore | undefined,
  reasoning?: ModelThinkingLevel,
): PiAiAdapter {
  return new PiAiAdapter({
    profiles: () => new Map<string, ResolvedPiAiProviderProfile>([[XAI_OAUTH_ROUTE, {
      provider: XAI_OAUTH_ROUTE,
      displayName: 'xAI Grok',
      streamIdleTimeoutMs: XAI_OAUTH_STREAM_IDLE_TIMEOUT_MS,
      retryPolicy: resolveRetryPolicy(undefined, 'dsh-xai retryPolicy'),
      configuredMaxTokens: new Map(),
      piProvider: session.provider(),
      ...reasoning === undefined ? {} : { reasoning },
    }]]),
    resolveApiKey: async () => {
      const auth = await session.models.getAuth(XAI_PI_PROVIDER)
      const apiKey = auth?.auth.apiKey
      if (apiKey === undefined || apiKey.length === 0) {
        throw new LlmError(
          'xAI Grok is not signed in. Open Settings → xAI Grok and sign in with SuperGrok or X Premium.',
          'MISSING_CREDENTIAL',
        )
      }
      return apiKey
    },
    resolveAttachments,
  })
}

/** Browser half: xAI Grok account management inside dsh Settings. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { XaiSettings } from './XaiSettings.tsx'
import type { XaiOAuthSettingsInjected } from './XaiSettings.tsx'
import { en, zh } from './locales.ts'
import type { XaiOAuthSettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.xai-oauth': XaiOAuthSettingsKey
  }
}

export const name = 'dsh-xai-client'
export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  const namespace = 'settings.xai-oauth'
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-xai: settings copy')
  const t = ctx.locale.bind(namespace) as XaiOAuthSettingsInjected['t']
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'xai-oauth',
    order: 16,
    label: () => t('nav'),
    inject: (): XaiOAuthSettingsInjected => ({ t }),
  }, XaiSettings))
}

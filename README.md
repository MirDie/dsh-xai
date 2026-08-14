# dsh-xai

Use a SuperGrok or X Premium subscription in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) through xAI's device-code sign-in — no `XAI_API_KEY` required, and no dsh source patch required.

This is an independent dsh bundle. It adds:

- SuperGrok / X Premium OAuth from the dsh Settings panel or a standalone CLI, with automatic token refresh
- optional one-shot import of `~/.grok/auth.json` (Grok CLI). The Grok file is never written
- after login or import, `GET https://api.x.ai/v1/models` narrows the picker to the signed-in account; the installed catalog is the fallback
- streaming, tool calls, reasoning, and dsh compaction through the normal LLM service

The catalog `xai` API-key route stays untouched. This plugin registers `xai-oauth` so both can coexist.

## Install

```sh
dsh plugin --profile web add .
dsh web
```

From a published package:

```sh
dsh plugin --profile web add dsh-xai
dsh web
```

Open **Settings → xAI Grok → Sign in with SuperGrok**. The plugin starts xAI's device-code flow, opens the verification URL, and polls until you approve. Headless / SSH hosts can use the CLI instead:

```sh
dsh plugin --profile web exec dsh-xai login
dsh plugin --profile web exec dsh-xai import
dsh plugin --profile web exec dsh-xai status
dsh plugin --profile web exec dsh-xai logout
```

The bundle selects `xai-oauth` / `grok-4.5` for new agents. A model already saved in dsh settings still takes precedence.

## Credentials

dsh keeps this login separate from the Grok CLI:

- credentials are stored at `$DSH_HOME/.xai-oauth-auth.json` (`~/.dsh` by default)
- writes are atomic and token refresh is locked across local dsh processes
- browser status and diagnostics never return token values
- `import` copies `~/.grok/auth.json` once and never writes that file

xAI refresh tokens rotate. After import, the next dsh refresh may invalidate Grok CLI until you run `grok login` again. Removing the bundle does not delete the dsh credential; use the account page or `logout`.

## Compatibility notes

- Chat, tool calls, and reasoning ride pi-ai's xAI provider (`openai-completions` / `openai-responses`).
- Some SuperGrok tiers have been seen to accept the browser login and then reject inference with HTTP 403. That is an xAI entitlement gate, not a stale token. Use `XAI_API_KEY` on the catalog `xai` route in that case.
- Filesystem, shell, skills, MCP, subagents, permissions, attachments, and compaction still come from the active dsh profile.

## Development

```sh
pnpm install
pnpm run check
```

## License

Apache-2.0

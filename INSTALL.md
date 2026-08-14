# Install dsh-xai

[English](INSTALL.md) | [中文](INSTALL.zh.md)

Idempotent runbook for humans and automation agents.

## Prerequisites

- DeepSeek Harness `dsh` on PATH (0.1.0-rc.6 or a checkout that can run `pnpm dsh`)
- A SuperGrok or X Premium account that xAI allows on the OAuth API
- A browser you can use to approve the device-code login

## Install into the web profile

Do not clone first. Point `dsh plugin add` at GitHub:

```sh
dsh plugin --profile web add github:MirDie/dsh-xai
```

From a DeepSeek Harness source checkout, prefix with `pnpm`:

```sh
pnpm dsh plugin --profile web add github:MirDie/dsh-xai
```

If pnpm ≥10 blocks the `prepare` build on a git spec, copy the printed package key into the profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-xai: true
```

and re-run `add`. This repository already ships `lib/`, so a local checkout used for development does not need a rebuild after `npm run build`.

## Clone only for development

```sh
git clone https://github.com/MirDie/dsh-xai.git
cd dsh-xai
npm install
npm run check
dsh plugin --profile web add .
```

## Sign in

Web UI:

1. `dsh web` (or `dsh --profile web`)
2. Settings → xAI Grok → Sign in with SuperGrok
3. Approve access in the browser
4. Pick `xai-oauth` / `grok-4.5` in the model picker if it is not already selected

CLI / headless:

```sh
dsh plugin --profile web exec dsh-xai login
dsh plugin --profile web exec dsh-xai import
dsh plugin --profile web exec dsh-xai status
```

`import` reads `~/.grok/auth.json` and writes only `$DSH_HOME/.xai-oauth-auth.json`. After a successful login or import the plugin calls `GET /v1/models` and caches the account-visible ids.

## Uninstall

```sh
dsh plugin --profile web exec dsh-xai logout
dsh plugin --profile web remove dsh-xai
```

Logout is required if the local OAuth document should be deleted. Removing the package leaves `$DSH_HOME/.xai-oauth-auth.json` in place.

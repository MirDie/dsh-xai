# 安装 dsh-xai

[English](INSTALL.md) | 中文

给人和其他自动化 agent 用的完整步骤。

## 先决条件

- PATH 上有 DeepSeek Harness 的 `dsh`（0.1.0-rc.6，或能跑 `pnpm dsh` 的源码检出）
- xAI 允许走 OAuth API 的 SuperGrok 或 X Premium 账号
- 能打开浏览器完成 device-code 授权

## 不必先拉取代码

日常安装用 GitHub 规格即可，`dsh` 会自己下载并装进 profile：

```sh
dsh plugin --profile web add github:MirDie/dsh-xai
dsh web
```

从 dsh 源码目录启动时：

```sh
pnpm dsh plugin --profile web add github:MirDie/dsh-xai
```

仓库已经带构建好的 `lib/`，git 安装不跑构建脚本。若你装到的还是旧提交、pnpm 仍提示 `allowBuilds` / `onlyBuiltDependencies`，把提示里的包名写进该 profile 的 `pnpm-workspace.yaml` 后再 `add` 一次：

```yaml
allowBuilds:
  dsh-xai: true
```

文件一般在 `~/.dsh/profiles/web/pnpm-workspace.yaml`（没有就新建）。不要改成 `npm dsh` 或在家目录跑 `pnpm dsh`。

## 只有开发时才 clone

```sh
git clone https://github.com/MirDie/dsh-xai.git
cd dsh-xai
npm install
npm run check
dsh plugin --profile web add .
```

## 登录

Web UI：

1. `dsh web`（或 `dsh --profile web`）
2. 设置 → xAI Grok → 使用 SuperGrok 登录
3. 在浏览器里批准
4. 在对话的模型选择器里选 `xai-oauth` / 某个 Grok 对话模型（如果还没选中）。本插件不会改掉 profile 原来的默认模型。

也可以导入本机已经登录过的 Grok CLI：设置页的「从 Grok CLI 导入」，或：

```sh
dsh plugin --profile web exec dsh-xai import
```

CLI / 无头：

```sh
dsh plugin --profile web exec dsh-xai login
dsh plugin --profile web exec dsh-xai status
```

`import` 只读 `$GROK_HOME/auth.json`（默认 `~/.grok/auth.json`），只写 `$DSH_HOME/.xai-oauth-auth.json`。登录或导入成功后会请求 `GET /v1/models`，并缓存账号可见的对话模型 id。

## 卸载

```sh
dsh plugin --profile web exec dsh-xai logout
dsh plugin --profile web remove dsh-xai
```

如果要删掉本地 OAuth 文件，需要先 `logout`。只 `remove` 包装不会删除 `$DSH_HOME/.xai-oauth-auth.json`。

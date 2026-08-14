# dsh-xai

[English](README.md) | 中文

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 里用 SuperGrok / X Premium 订阅登录 xAI，调用 Grok。不需要 `XAI_API_KEY`，也不需要改 dsh 源码。

这是一个独立的 dsh bundle，会提供：

- Settings 或 CLI 里的 SuperGrok / X Premium OAuth，并自动刷新 token
- 一次性导入 `~/.grok/auth.json`（Grok CLI）。**不会改写**那个文件
- 登录或导入后请求 `GET https://api.x.ai/v1/models`，模型列表按当前账号收窄；拉失败则用安装目录兜底
- 流式、工具调用、reasoning、compaction 走 dsh 原有 LLM 服务

内置目录里的 `xai`（API Key）路由不会被动。本插件注册的是 `xai-oauth`，两条路可以并存。

## 安装

**不用先自己 clone。** `dsh plugin add` 会按 GitHub 地址把包装进当前 profile。

```sh
dsh plugin --profile web add github:MirDie/dsh-xai
dsh web
```

用 `npx` 起的 Web、PATH 里没有 `dsh` 时，把前面的 `dsh` 换成 `npx @deepseek-ai/dsh`：

```sh
npx @deepseek-ai/dsh plugin --profile web add github:MirDie/dsh-xai
npx @deepseek-ai/dsh web
```

不要写 `npm dsh` 或在家目录里写 `pnpm dsh`。`npx` 只是临时跑一次，不会安装全局 `dsh` 命令。

打开 **设置 → xAI Grok → 使用 SuperGrok 登录**。插件会走 device-code，打开验证链接，你在浏览器里批准即可。无头 / SSH 可以用 CLI：

```sh
dsh plugin --profile web exec dsh-xai login
dsh plugin --profile web exec dsh-xai import
dsh plugin --profile web exec dsh-xai status
dsh plugin --profile web exec dsh-xai logout
```

新会话默认选 `xai-oauth` / `grok-4.5`。dsh 里已经存过的默认模型仍然优先。

设置页可以勾选要出现在模型选择器里的模型。名称形如 `xai-oauth / grok-4.5`。登录后如果选择器还是空的，更新插件并重启 `dsh web`。

只有在改这个插件本身时，才需要把仓库拉到本地，再用路径安装：

```sh
git clone https://github.com/MirDie/dsh-xai.git
dsh plugin --profile web add ./dsh-xai
```

## 凭证

dsh 的登录和 Grok CLI 是分开的：

- 凭证写在 `$DSH_HOME/.xai-oauth-auth.json`（默认 `~/.dsh`）
- 写入是原子的，refresh 会跨本机 dsh 进程加锁
- 浏览器状态和报错里不会带回 token
- `import` 只复制一次 `~/.grok/auth.json`，从不写回那个文件

xAI 的 refresh token 会轮换。导入之后，dsh 下一次刷新可能让 Grok CLI 掉线，需要再跑一次 `grok login`。卸掉插件不会删除 dsh 凭证；要删请用设置页或 `logout`。

## 兼容说明

- 对话、工具、reasoning 走 pi-ai 的 xAI 提供商（`openai-completions` / `openai-responses`）。
- 部分 SuperGrok 档位会出现「浏览器登录成功，推理 HTTP 403」。这是 xAI 侧权限，不是 token 过期。这种情况请改用目录里的 `xai` + `XAI_API_KEY`。
- 文件系统、shell、skills、MCP、子代理、权限、附件、compaction 仍由当前 dsh profile 提供。

## 开发

```sh
npm install
npm run check
```

## 许可证

Apache-2.0

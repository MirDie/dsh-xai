import z from "@deepseek-ai/schemastery";
import { LlmError, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { createModels } from "@earendil-works/pi-ai";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
//#region src/ids.ts
/** pi-ai provider id used by login, refresh, and the credential store. */
const XAI_PI_PROVIDER = "xai";
/** Harness LLM route. Distinct from the catalog `xai` API-key route. */
const XAI_OAUTH_ROUTE = "xai-oauth";
/** Basename of the OAuth document inside the Harness home. */
const XAI_OAUTH_AUTH_FILENAME = ".xai-oauth-auth.json";
/** Fallback model when the installed pi-ai catalog has no grok-4.6. */
const DEFAULT_XAI_OAUTH_MODEL = "grok-4.5";
/** Provider idle ceiling used by the composite route. */
const XAI_OAUTH_STREAM_IDLE_TIMEOUT_MS = 3e5;
//#endregion
//#region src/catalog.ts
const XAI_MODELS_URL = "https://api.x.ai/v1/models";
const BODY_LIMIT_BYTES = 4194304;
const LIST_TIMEOUT_MS = 15e3;
const NON_CHAT_MODEL = /imagine|image|video|tts|voice|stt|whisper|embed|realtime|audio/i;
/** Chat-capable Grok ids, plus anything already in the installed catalog. */
function isSelectableChatModel(id, catalogIds) {
	if (catalogIds?.has(id)) return true;
	if (!id.toLowerCase().startsWith("grok")) return false;
	return !NON_CHAT_MODEL.test(id);
}
function isRecord$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Pull model ids from an OpenAI-shaped or gateway-shaped listing body. */
function extractModelIds(body) {
	const rows = Array.isArray(body) ? body : isRecord$1(body) && Array.isArray(body["data"]) ? body["data"] : isRecord$1(body) && Array.isArray(body["models"]) ? body["models"] : [];
	const ids = [];
	for (const row of rows) if (typeof row === "string" && row.length > 0) ids.push(row);
	else if (isRecord$1(row) && typeof row["id"] === "string" && row["id"].length > 0) ids.push(row["id"]);
	return [...new Set(ids)];
}
function titleCaseId(id) {
	return id.split(/[-_]/g).map((part) => part.length === 0 ? part : part[0].toUpperCase() + part.slice(1)).join(" ");
}
function catalogModels(baseline = xaiProvider().getModels()) {
	return baseline;
}
function templateFor(id, catalog) {
	const exact = catalog.find((model) => model.id === id);
	if (exact !== void 0) return exact;
	const lower = id.toLowerCase();
	const fallback = catalog.find((model) => model.id === "grok-4.5") ?? catalog[0];
	if (fallback === void 0) throw new Error("xai-oauth: installed xAI catalog is empty");
	if (lower.includes("build") || lower.includes("code-fast")) return catalog.find((model) => model.id === "grok-build-0.1") ?? fallback;
	if (/grok-4\.[56]/.test(lower) || lower.includes("4.20") || lower.includes("reasoning")) return catalog.find((model) => model.api === "openai-responses") ?? fallback;
	return fallback;
}
/** Turn a live id into a pi-ai model, inheriting catalog metadata when possible. */
function materializeLiveModel(id, catalog = catalogModels()) {
	const template = templateFor(id, catalog);
	if (template.id === id) return template;
	return {
		...template,
		id,
		name: titleCaseId(id)
	};
}
/**
* If `liveIds` is missing or empty, serve the installed catalog.
* Otherwise serve only the live ids, each materialized against the catalog.
*/
function mergeLiveCatalog(catalog, liveIds) {
	if (liveIds === void 0 || liveIds.length === 0) return [...catalog];
	const catalogIds = new Set(catalog.map((model) => model.id));
	const chatIds = liveIds.filter((id) => isSelectableChatModel(id, catalogIds));
	if (chatIds.length === 0) return [...catalog];
	return chatIds.map((id) => materializeLiveModel(id, catalog));
}
function preferredXaiOAuthModelFrom(models) {
	const ids = new Set(models.map((model) => model.id));
	if (ids.has("grok-4.6")) return "grok-4.6";
	if (ids.has("grok-4.5")) return DEFAULT_XAI_OAUTH_MODEL;
	return models[0]?.id ?? "grok-4.5";
}
/** Fetch the account-visible model ids. Throws a secret-free error on failure. */
async function fetchLiveModelIds(accessToken, signal) {
	const timeout = AbortSignal.timeout(LIST_TIMEOUT_MS);
	const combined = signal === void 0 ? timeout : AbortSignal.any([signal, timeout]);
	let response;
	try {
		response = await fetch(XAI_MODELS_URL, {
			headers: {
				accept: "application/json",
				authorization: `Bearer ${accessToken}`
			},
			signal: combined
		});
	} catch (error) {
		if (combined.aborted) throw new Error(signal?.aborted ? "Live model listing was cancelled" : "xAI model listing timed out");
		throw new Error("xAI model listing is unreachable");
	}
	const raw = Buffer.from(await response.arrayBuffer());
	if (raw.byteLength > BODY_LIMIT_BYTES) throw new Error("xAI model listing exceeded the 4 MiB read ceiling");
	let body;
	try {
		body = JSON.parse(raw.toString("utf8"));
	} catch {
		throw new Error(`xAI model listing returned invalid JSON (HTTP ${response.status})`);
	}
	if (!response.ok) {
		const code = isRecord$1(body) && typeof body["error"] === "string" ? body["error"] : void 0;
		throw new Error(`xAI model listing failed (HTTP ${response.status})${code === void 0 ? "" : `: ${code}`}`);
	}
	const ids = extractModelIds(body);
	if (ids.length === 0) throw new Error("xAI model listing contained no model ids");
	return ids;
}
//#endregion
//#region src/trust.ts
/** Loopback Host fence and secret-free authorization URL checks. */
const XAI_AUTH_HOSTS = ["auth.x.ai", "accounts.x.ai"];
var RequestBodyTooLargeError = class extends Error {
	constructor() {
		super("request body too large");
		this.name = "RequestBodyTooLargeError";
	}
};
/** True when Host is a loopback authority (DNS-rebinding defense). */
function isLoopbackHost(hostHeader) {
	try {
		const hostname = new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
		return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
	} catch {
		return false;
	}
}
function isLoopbackAddress(remote) {
	return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}
/**
* Same reachability posture as dsh `/api`: loopback socket + loopback Host.
* Origin, when present, must match Host. Cross-site Fetch Metadata is refused.
*/
function trustedRequest(req) {
	if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
	const host = req.headers.host;
	if (host === void 0 || !isLoopbackHost(host)) return false;
	if (req.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = req.headers.origin;
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === new URL(`http://${host}`).host;
	} catch {
		return false;
	}
}
/** Reject non-HTTPS URLs and hosts other than xAI's auth servers. */
function assertSafeAuthorizationUrl(raw) {
	let url;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("xAI returned an invalid authorization URL");
	}
	if (url.protocol !== "https:") throw new Error("xAI returned an unsafe authorization URL");
	const host = url.hostname.toLowerCase();
	if (!XAI_AUTH_HOSTS.includes(host)) throw new Error("xAI returned an authorization URL on an unexpected host");
	return url.href;
}
function isTerminalOAuthFailure(error) {
	const message = error instanceof Error ? error.message : String(error);
	return /invalid_grant|authorization revoked|refresh token.*(expired|revoked)|revoked grant/i.test(message);
}
//#endregion
//#region src/adapter.ts
/** xAI subscription adapter assembled from public dsh-llm-pi-ai extension points. */
/** Prefer grok-4.6 when the current (live or installed) list has it. */
function preferredXaiOAuthModel(models = xaiProvider().getModels()) {
	return preferredXaiOAuthModelFrom(models);
}
/**
* Create the SuperGrok adapter without a dsh fork.
* The public pi-ai adapter owns streaming, tools, reasoning, and compaction;
* this plugin supplies a refreshable OAuth token and an account model list.
*/
function createXaiOAuthAdapter(session, resolveAttachments) {
	return new PiAiAdapter({
		profiles: () => /* @__PURE__ */ new Map([[XAI_OAUTH_ROUTE, {
			provider: XAI_OAUTH_ROUTE,
			displayName: "xAI Grok",
			streamIdleTimeoutMs: XAI_OAUTH_STREAM_IDLE_TIMEOUT_MS,
			retryPolicy: resolveRetryPolicy(void 0, "dsh-xai retryPolicy"),
			configuredMaxTokens: /* @__PURE__ */ new Map(),
			piProvider: session.provider()
		}]]),
		resolveApiKey: async () => {
			try {
				const apiKey = await session.accessToken();
				if (apiKey === void 0 || apiKey.length === 0) throw new LlmError("xAI Grok is not signed in. Open Settings → xAI Grok and sign in with SuperGrok or X Premium.", "MISSING_CREDENTIAL");
				return apiKey;
			} catch (error) {
				if (error instanceof LlmError) throw error;
				if (isTerminalOAuthFailure(error)) throw new LlmError("xAI Grok sign-in expired. Open Settings → xAI Grok and sign in again.", "MISSING_CREDENTIAL");
				throw error;
			}
		},
		resolveAttachments
	});
}
//#endregion
//#region src/grok-import.ts
/**
* One-shot import of Grok CLI credentials into the dsh-owned store.
* The source file is never written. Refresh tokens rotate, so later dsh
* refresh may invalidate ~/.grok/auth.json — that is documented, not a bug.
* @module dsh-xai/grok-import
*/
const DEFAULT_TOKEN_LIFETIME_MS = 36e5;
function isENOENT$2(error) {
	return error?.code === "ENOENT";
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonEmptyString(value) {
	return typeof value === "string" && value.length > 0 ? value : void 0;
}
function firstString(record, keys) {
	for (const key of keys) {
		const value = nonEmptyString(record[key]);
		if (value !== void 0) return value;
	}
}
function parseTime(value) {
	const parsed = Date.parse(value);
	if (Number.isFinite(parsed) && parsed > 0) return parsed;
	const trimmed = value.replace(/(\.\d{3})\d+/, "$1");
	const again = Date.parse(trimmed);
	return Number.isFinite(again) && again > 0 ? again : NaN;
}
function parseExpires(record) {
	const expiresAt = record["expires_at"];
	if (typeof expiresAt === "string" && expiresAt.length > 0) {
		const parsed = parseTime(expiresAt);
		if (Number.isFinite(parsed)) return parsed;
	}
	if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > 0) return expiresAt < 0xe8d4a51000 ? expiresAt * 1e3 : expiresAt;
	const expires = record["expires"];
	if (typeof expires === "number" && Number.isFinite(expires) && expires > 0) return expires < 0xe8d4a51000 ? expires * 1e3 : expires;
	const expiresIn = record["expires_in"];
	if (typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0) return Date.now() + expiresIn * 1e3;
	return Date.now() + DEFAULT_TOKEN_LIFETIME_MS;
}
function walk(value, key) {
	if (Array.isArray(value)) return value.flatMap((item, index) => walk(item, `${key}[${index}]`));
	if (!isRecord(value)) return [];
	const access = firstString(value, [
		"key",
		"access",
		"access_token"
	]);
	const refresh = firstString(value, ["refresh_token", "refresh"]);
	if (access !== void 0 && refresh !== void 0) {
		const issuer = firstString(value, ["oidc_issuer", "issuer"]);
		const preferred = key.includes("auth.x.ai") || issuer !== void 0 && issuer.includes("auth.x.ai");
		const accountId = firstString(value, [
			"user_id",
			"accountId",
			"principal_id"
		]);
		return [{
			credential: {
				type: "oauth",
				access,
				refresh,
				expires: parseExpires(value),
				...accountId === void 0 ? {} : { accountId }
			},
			preferred
		}];
	}
	return Object.entries(value).flatMap(([child, nested]) => walk(nested, child));
}
/**
* Resolve the Grok CLI auth document.
* With no `home` argument, honor `GROK_HOME` (the Grok config root) then `~/.grok`.
* An explicit `home` is treated as the user home, matching `~/.grok/auth.json`.
*/
function grokAuthPath(home) {
	if (home !== void 0) return resolve(join(home, ".grok", "auth.json"));
	const grokHome = process.env["GROK_HOME"]?.trim();
	if (grokHome !== void 0 && grokHome.length > 0) return resolve(join(grokHome, "auth.json"));
	return resolve(join(homedir(), ".grok", "auth.json"));
}
/** Parse a Grok CLI / generic OAuth document into a pi-ai credential. */
function parseGrokAuthDocument(text, filename) {
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error(`xai-oauth: ${filename} is not valid JSON`);
	}
	const candidates = walk(value, "");
	if (candidates.length === 0) throw new Error(`xai-oauth: ${filename} does not contain a Grok OAuth refresh token`);
	return (candidates.find((candidate) => candidate.preferred) ?? candidates[0]).credential;
}
/** Whether ~/.grok/auth.json exists and looks importable. Never returns secrets. */
async function probeGrokAuth(filename = grokAuthPath()) {
	try {
		await stat(filename);
		parseGrokAuthDocument(await readFile(filename, "utf8"), filename);
		return {
			available: true,
			path: filename
		};
	} catch (error) {
		if (isENOENT$2(error)) return {
			available: false,
			path: filename
		};
		return {
			available: false,
			path: filename
		};
	}
}
/** Copy Grok CLI tokens into the dsh store. Does not write the Grok file. */
async function importGrokAuth(store, filename = grokAuthPath()) {
	let text;
	try {
		text = await readFile(filename, "utf8");
	} catch (error) {
		if (isENOENT$2(error)) throw new Error(`xai-oauth: Grok CLI auth file not found at ${filename}`);
		throw error;
	}
	const credential = parseGrokAuthDocument(text, filename);
	const written = await store.modify("xai", async () => credential);
	if (written === void 0 || written.type !== "oauth") throw new Error("xai-oauth: failed to persist the imported Grok credential");
	return written;
}
//#endregion
//#region src/store.ts
/**
* Owner-only persistent OAuth credential storage for the xAI subscription route.
* @module dsh-xai/store
*/
/** Current on-disk format; readers reject every other version. */
const AUTH_FORMAT_VERSION = 1;
function isENOENT$1(error) {
	return error?.code === "ENOENT";
}
async function restrictWindowsAcl(filename) {
	if (process.platform !== "win32") return;
	const user = process.env["USERNAME"];
	if (user === void 0 || user.length === 0) return;
	await new Promise((resolvePromise) => {
		const child = spawn("icacls", [
			filename,
			"/inheritance:r",
			"/grant:r",
			`${user}:(R,W)`
		], {
			windowsHide: true,
			stdio: "ignore"
		});
		child.on("error", () => {
			resolvePromise();
		});
		child.on("exit", () => {
			resolvePromise();
		});
	});
}
async function assertOwnerOnly(filename) {
	let mode;
	try {
		mode = (await stat(filename)).mode;
	} catch (error) {
		if (isENOENT$1(error)) return;
		throw error;
	}
	if (process.platform === "win32") return;
	if ((mode & 63) !== 0) throw new Error(`xai-oauth: ${filename} is readable beyond its owner (mode ${(mode & 511).toString(8)}); run "chmod 600 ${filename}" before starting again`);
}
function parseDocument(text, filename) {
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error(`xai-oauth: ${filename} is not valid JSON`);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`xai-oauth: ${filename} must contain an object`);
	const document = value;
	if (document["version"] !== AUTH_FORMAT_VERSION) throw new Error(`xai-oauth: ${filename} has unsupported auth format version ${String(document["version"])}`);
	if (Object.keys(document).some((key) => key !== "version" && key !== "credential")) throw new Error(`xai-oauth: ${filename} contains an unknown top-level field`);
	const raw = document["credential"];
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`xai-oauth: ${filename} credential must be an object`);
	const credential = raw;
	const allowed = /* @__PURE__ */ new Set([
		"type",
		"access",
		"refresh",
		"expires",
		"accountId"
	]);
	if (Object.keys(credential).some((key) => !allowed.has(key))) throw new Error(`xai-oauth: ${filename} credential contains an unknown field`);
	if (credential["type"] !== "oauth") throw new Error(`xai-oauth: ${filename} credential type must be oauth`);
	for (const key of ["access", "refresh"]) if (typeof credential[key] !== "string" || credential[key].length === 0) throw new Error(`xai-oauth: ${filename} credential ${key} must be a non-empty string`);
	if (credential["accountId"] !== void 0 && (typeof credential["accountId"] !== "string" || credential["accountId"].length === 0)) throw new Error(`xai-oauth: ${filename} credential accountId must be a non-empty string when present`);
	if (typeof credential["expires"] !== "number" || !Number.isFinite(credential["expires"]) || credential["expires"] <= 0) throw new Error(`xai-oauth: ${filename} credential expires must be a positive finite number`);
	return {
		version: AUTH_FORMAT_VERSION,
		credential
	};
}
function cloneCredential(credential) {
	return structuredClone(credential);
}
/** Resolve the default OAuth document path. */
function xaiOAuthAuthPath(dshHome) {
	return resolve(join(resolveDshHome(dshHome), XAI_OAUTH_AUTH_FILENAME));
}
/** File-backed pi-ai store scoped to the single xAI provider. */
var XaiOAuthCredentialStore = class {
	filename;
	constructor(filename = xaiOAuthAuthPath()) {
		this.filename = resolve(filename);
	}
	async readCurrent() {
		await assertOwnerOnly(this.filename);
		let text;
		try {
			text = await readFile(this.filename, "utf8");
		} catch (error) {
			if (isENOENT$1(error)) return void 0;
			throw error;
		}
		return cloneCredential(parseDocument(text, this.filename).credential);
	}
	async read(providerId) {
		return providerId === "xai" ? this.readCurrent() : void 0;
	}
	async list() {
		return await this.readCurrent() === void 0 ? [] : [{
			providerId: "xai",
			type: "oauth"
		}];
	}
	async modify(providerId, fn) {
		if (providerId !== "xai") throw new Error(`xai-oauth: credential store does not own provider "${providerId}"`);
		await mkdir(dirname(this.filename), {
			recursive: true,
			mode: 448
		});
		return withFileLock(this.filename, async () => {
			const current = await this.readCurrent();
			const candidate = await fn(current);
			if (candidate === void 0) return current;
			const document = parseDocument(JSON.stringify({
				version: AUTH_FORMAT_VERSION,
				credential: candidate
			}), this.filename);
			await writeFileAtomic(this.filename, `${JSON.stringify(document, null, 2)}\n`, {
				mode: 384,
				dirMode: 448
			});
			await restrictWindowsAcl(this.filename);
			return cloneCredential(document.credential);
		});
	}
	async delete(providerId) {
		if (providerId !== "xai") return;
		await mkdir(dirname(this.filename), {
			recursive: true,
			mode: 448
		});
		await withFileLock(this.filename, () => rm(this.filename, { force: true }));
	}
};
//#endregion
//#region src/auth.ts
/**
* xAI OAuth orchestration shared by the plugin and standalone launcher.
* @module dsh-xai/auth
*/
/** Complete provider-native OAuth and persist the resulting credential. */
async function loginXaiOAuth(interaction, store = new XaiOAuthCredentialStore()) {
	const models = createModels({ credentials: store });
	models.setProvider(xaiProvider());
	await models.login("xai", "oauth", interaction);
}
/** Copy ~/.grok/auth.json into the dsh store. Does not modify the Grok file. */
async function importXaiOAuthFromGrok(store = new XaiOAuthCredentialStore(), filename) {
	await importGrokAuth(store, filename);
}
/** Remove the stored xAI OAuth credential. */
async function logoutXaiOAuth(store = new XaiOAuthCredentialStore()) {
	await store.delete("xai");
}
/** Read non-secret login state without refreshing the token. */
async function xaiOAuthAuthStatus(store = new XaiOAuthCredentialStore()) {
	const credential = await store.read("xai");
	return credential?.type === "oauth" ? {
		authenticated: true,
		expiresAt: new Date(credential.expires)
	} : { authenticated: false };
}
/** Login then refresh the account model list when a session is available. */
async function loginXaiOAuthSession(interaction, session) {
	await loginXaiOAuth(interaction, session.store);
	await session.refreshLiveCatalog();
}
async function importXaiOAuthSession(session, filename) {
	await importXaiOAuthFromGrok(session.store, filename);
	await session.refreshLiveCatalog();
}
//#endregion
//#region src/redact.ts
/** Remove token-like strings from an external OAuth diagnostic. */
function safeMessage(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, "$1[redacted]").slice(0, 1e3);
}
//#endregion
//#region src/auth-routes.ts
const XAI_OAUTH_AUTH_STATUS_PATH = "/plugins/dsh-xai/auth/status";
const XAI_OAUTH_AUTH_LOGIN_PATH = "/plugins/dsh-xai/auth/login";
const XAI_OAUTH_AUTH_IMPORT_PATH = "/plugins/dsh-xai/auth/import";
const XAI_OAUTH_AUTH_LOGOUT_PATH = "/plugins/dsh-xai/auth/logout";
const XAI_OAUTH_AUTH_MODELS_PATH = "/plugins/dsh-xai/auth/models";
function waitForPromptAbort(prompt) {
	const signal = prompt.signal;
	if (signal === void 0) return new Promise(() => {});
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((_resolve, reject) => {
		signal.addEventListener("abort", () => {
			reject(signal.reason);
		}, { once: true });
	});
}
async function grokImportAvailable() {
	return (await probeGrokAuth()).available;
}
/** One lifecycle owner for the device-code poller, challenge, and public status. */
var XaiOAuthWebAuth = class {
	session;
	state = {
		status: "signed-out",
		grokImportAvailable: false
	};
	operation;
	cancellation;
	challenge;
	challengeWaiters = [];
	constructor(session) {
		this.session = session;
	}
	async status() {
		if (this.operation !== void 0) return this.state;
		if (this.state.status === "error") return {
			...this.state,
			grokImportAvailable: await grokImportAvailable()
		};
		return this.readStoredStatus();
	}
	async signIn() {
		if (this.operation === void 0) this.start();
		if (this.challenge !== void 0) return this.challenge;
		return new Promise((resolve, reject) => {
			this.challengeWaiters.push({
				resolve,
				reject
			});
		});
	}
	async importGrok() {
		this.cancellation?.abort(/* @__PURE__ */ new Error("xAI Grok sign-in cancelled"));
		await this.operation?.catch(() => void 0);
		await importXaiOAuthSession(this.session);
		this.challenge = void 0;
		this.state = await this.readStoredStatus();
	}
	async setModels(ids) {
		await this.session.setSelectedModels(ids);
		this.state = await this.readStoredStatus();
	}
	async signOut() {
		this.cancellation?.abort(/* @__PURE__ */ new Error("xAI Grok sign-in cancelled"));
		await this.operation?.catch(() => void 0);
		await this.session.logout();
		this.state = {
			status: "signed-out",
			grokImportAvailable: await grokImportAvailable()
		};
		this.challenge = void 0;
	}
	async dispose() {
		this.cancellation?.abort(/* @__PURE__ */ new Error("xAI Grok plugin disposed"));
		await this.operation?.catch(() => void 0);
	}
	start() {
		const cancellation = new AbortController();
		this.cancellation = cancellation;
		this.challenge = void 0;
		this.state = {
			status: "signing-in",
			grokImportAvailable: false
		};
		this.operation = loginXaiOAuthSession({
			signal: cancellation.signal,
			prompt: (prompt) => prompt.type === "select" ? Promise.resolve(prompt.options.some((option) => option.id === "oauth") ? "oauth" : prompt.options[0]?.id ?? "oauth") : waitForPromptAbort(prompt),
			notify: (event) => {
				this.onEvent(event);
			}
		}, this.session).then(async () => {
			this.state = await this.readStoredStatus();
		}, (error) => {
			this.rejectChallenge(error);
			this.state = {
				status: "error",
				message: safeMessage(error),
				grokImportAvailable: false
			};
		}).finally(() => {
			this.operation = void 0;
			this.cancellation = void 0;
		});
	}
	onEvent(event) {
		if (event.type === "device_code") {
			this.acceptChallenge({
				url: event.verificationUri,
				...event.userCode.length > 0 ? { userCode: event.userCode } : {}
			});
			return;
		}
		if (event.type === "auth_url") this.acceptChallenge({ url: event.url });
	}
	acceptChallenge(challenge) {
		try {
			assertSafeAuthorizationUrl(challenge.url);
		} catch (error) {
			const rejected = error instanceof Error ? error : /* @__PURE__ */ new Error("xAI returned an invalid authorization URL");
			this.cancellation?.abort(rejected);
			this.rejectChallenge(rejected);
			return;
		}
		this.challenge = challenge;
		this.state = {
			status: "signing-in",
			url: challenge.url,
			grokImportAvailable: false,
			...challenge.userCode === void 0 ? {} : { userCode: challenge.userCode }
		};
		for (const waiter of this.challengeWaiters.splice(0)) waiter.resolve(challenge);
	}
	async readStoredStatus() {
		const [stored, grok] = await Promise.all([xaiOAuthAuthStatus(this.session.store), grokImportAvailable()]);
		if (!stored.authenticated) return {
			status: "signed-out",
			grokImportAvailable: grok
		};
		const available = this.session.availableModels().map((model) => model.id);
		const selected = this.session.selectedModelIds();
		return {
			status: "signed-in",
			models: this.session.visibleModels().map((model) => model.id),
			available,
			selected: selected ?? available,
			catalogSource: this.session.catalogSource,
			grokImportAvailable: grok,
			...this.session.catalogError === void 0 ? {} : { catalogError: this.session.catalogError }
		};
	}
	rejectChallenge(error) {
		for (const waiter of this.challengeWaiters.splice(0)) waiter.reject(error);
	}
};
async function readJson(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buf.byteLength;
		if (size > 65536) throw new RequestBodyTooLargeError();
		chunks.push(buf);
	}
	const text = Buffer.concat(chunks).toString("utf8").trim();
	if (text.length === 0) return {};
	return JSON.parse(text);
}
function json(res, status, value) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff"
	});
	res.end(JSON.stringify(value));
}
/** Register the plugin-owned OAuth routes when the Web server is composed. */
function registerXaiOAuthAuthRoutes(ctx, session) {
	const auth = new XaiOAuthWebAuth(session);
	ctx.effect(() => {
		const routes = [
			ctx.webServer.register({
				kind: "exact",
				path: XAI_OAUTH_AUTH_STATUS_PATH,
				handler: async (req, res) => {
					if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
					if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
					json(res, 200, await auth.status());
				}
			}),
			ctx.webServer.register({
				kind: "exact",
				path: XAI_OAUTH_AUTH_LOGIN_PATH,
				handler: async (req, res) => {
					if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
					if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
					try {
						json(res, 200, await auth.signIn());
					} catch (error) {
						json(res, 500, { error: safeMessage(error) });
					}
				}
			}),
			ctx.webServer.register({
				kind: "exact",
				path: XAI_OAUTH_AUTH_IMPORT_PATH,
				handler: async (req, res) => {
					if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
					if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
					try {
						await auth.importGrok();
						json(res, 200, await auth.status());
					} catch (error) {
						json(res, 500, { error: safeMessage(error) });
					}
				}
			}),
			ctx.webServer.register({
				kind: "exact",
				path: XAI_OAUTH_AUTH_MODELS_PATH,
				handler: async (req, res) => {
					if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
					if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
					try {
						const body = await readJson(req);
						const selected = typeof body === "object" && body !== null && "selected" in body ? body.selected : void 0;
						if (!Array.isArray(selected) || selected.some((id) => typeof id !== "string")) return json(res, 400, { error: "selected must be an array of model ids" });
						await auth.setModels(selected);
						json(res, 200, await auth.status());
					} catch (error) {
						if (error instanceof RequestBodyTooLargeError) return json(res, 413, { error: error.message });
						if (error instanceof SyntaxError) return json(res, 400, { error: "invalid json" });
						json(res, 500, { error: safeMessage(error) });
					}
				}
			}),
			ctx.webServer.register({
				kind: "exact",
				path: XAI_OAUTH_AUTH_LOGOUT_PATH,
				handler: async (req, res) => {
					if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
					if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
					await auth.signOut();
					json(res, 200, { ok: true });
				}
			})
		];
		return async () => {
			for (const dispose of routes) dispose();
			await auth.dispose();
		};
	}, "dsh-xai: Web OAuth routes");
}
//#endregion
//#region src/session.ts
/**
* Shared OAuth store + live catalog for the host plugin and CLI.
* @module dsh-xai/session
*/
const MODELS_CACHE_VERSION = 2;
const MODELS_CACHE_FILENAME = ".xai-oauth-models.json";
function isENOENT(error) {
	return error?.code === "ENOENT";
}
function modelsCachePath(dshHome) {
	return resolve(join(resolveDshHome(dshHome), MODELS_CACHE_FILENAME));
}
function parseIdList(value) {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.filter((id) => typeof id === "string" && id.length > 0))];
}
function parseCache(text) {
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const document = value;
	if (document["version"] !== 1 && document["version"] !== MODELS_CACHE_VERSION) return void 0;
	const ids = parseIdList(document["ids"]);
	const selected = parseIdList(document["selected"]);
	if (ids.length === 0 && selected.length === 0) return void 0;
	return {
		ids,
		...selected.length === 0 ? {} : { selected }
	};
}
function asHarnessModels(models) {
	return models.map((model) => model.provider === "xai-oauth" ? model : {
		...model,
		provider: XAI_OAUTH_ROUTE
	});
}
function requestProvider(provider) {
	return {
		...provider,
		auth: {
			...provider.auth,
			apiKey: {
				name: "xAI Grok OAuth bearer token",
				async resolve({ credential }) {
					const apiKey = credential?.key;
					return apiKey === void 0 || apiKey.length === 0 ? void 0 : {
						auth: { apiKey },
						source: "OAuth"
					};
				}
			}
		}
	};
}
/** One process-local owner of the credential and the account model list. */
var XaiOAuthSession = class {
	store;
	models;
	baseline;
	liveIds;
	selectedIds;
	source = "fallback";
	listingError;
	cacheFile;
	onCatalogChange;
	catalogGeneration = 0;
	constructor(store = new XaiOAuthCredentialStore(), onCatalogChange, options) {
		this.store = store;
		this.cacheFile = options?.cacheFile ?? modelsCachePath();
		this.baseline = xaiProvider();
		this.models = createModels({ credentials: store });
		this.models.setProvider(this.baseline);
		this.onCatalogChange = onCatalogChange;
	}
	/** Secret-free listing diagnostic from the last refresh. */
	get catalogError() {
		return this.listingError;
	}
	get catalogSource() {
		return this.source;
	}
	availableModels() {
		return mergeLiveCatalog(this.baseline.getModels(), this.liveIds);
	}
	selectedModelIds() {
		return this.selectedIds;
	}
	visibleModels() {
		const available = this.availableModels();
		if (this.selectedIds === void 0 || this.selectedIds.length === 0) return available;
		const byId = new Map(available.map((model) => [model.id, model]));
		const catalog = this.baseline.getModels();
		return this.selectedIds.map((id) => byId.get(id) ?? materializeLiveModel(id, catalog));
	}
	/** Provider whose id matches the harness route so PiAiAdapter can list models. */
	provider() {
		return {
			...requestProvider(this.baseline),
			id: XAI_OAUTH_ROUTE,
			name: "xAI Grok",
			getModels: () => asHarnessModels(this.visibleModels())
		};
	}
	async loadCachedCatalog() {
		try {
			const cache = parseCache(await readFile(this.cacheFile, "utf8"));
			if (cache === void 0) return;
			if (cache.ids.length > 0) {
				this.liveIds = cache.ids;
				this.source = "cache";
			}
			this.selectedIds = cache.selected;
		} catch (error) {
			if (!isENOENT(error)) throw error;
		}
	}
	/**
	* OAuth bearer only. Never falls through to `XAI_API_KEY`.
	* Terminal refresh failures clear the stored grant.
	*/
	async accessToken() {
		if ((await this.store.read("xai"))?.type !== "oauth") return void 0;
		try {
			const apiKey = (await this.models.getAuth("xai"))?.auth.apiKey;
			return apiKey !== void 0 && apiKey.length > 0 ? apiKey : void 0;
		} catch (error) {
			if (isTerminalOAuthFailure(error)) await this.store.delete("xai");
			throw error;
		}
	}
	async refreshLiveCatalog(signal) {
		const generation = this.catalogGeneration;
		let access;
		try {
			access = await this.accessToken();
		} catch (error) {
			if (generation !== this.catalogGeneration) return;
			this.listingError = safeMessage(error);
			if (this.liveIds === void 0) this.source = "fallback";
			return;
		}
		if (access === void 0 || access.length === 0) {
			this.listingError = void 0;
			return;
		}
		try {
			const ids = await fetchLiveModelIds(access, signal);
			if (generation !== this.catalogGeneration) return;
			this.liveIds = ids;
			this.source = "live";
			this.listingError = void 0;
			await this.writeCache();
			this.onCatalogChange?.();
		} catch (error) {
			if (generation !== this.catalogGeneration) return;
			this.listingError = safeMessage(error);
			if (this.liveIds === void 0) this.source = "fallback";
		}
	}
	async setSelectedModels(ids) {
		const available = new Set(this.availableModels().map((model) => model.id));
		const unique = [...new Set(ids.filter((id) => id.length > 0 && id.length < 200 && available.has(id)))].slice(0, 64);
		this.selectedIds = unique.length === 0 ? void 0 : unique;
		await this.writeCache();
		this.onCatalogChange?.();
	}
	async logout() {
		this.catalogGeneration += 1;
		await this.store.delete("xai");
		this.liveIds = void 0;
		this.selectedIds = void 0;
		this.source = "fallback";
		this.listingError = void 0;
		await mkdir(dirname(this.cacheFile), {
			recursive: true,
			mode: 448
		});
		await rm(this.cacheFile, { force: true });
		this.onCatalogChange?.();
	}
	async writeCache() {
		const document = {
			version: MODELS_CACHE_VERSION,
			ids: this.liveIds === void 0 ? [] : [...this.liveIds],
			fetchedAt: Date.now(),
			...this.selectedIds === void 0 ? {} : { selected: [...this.selectedIds] }
		};
		await mkdir(dirname(this.cacheFile), {
			recursive: true,
			mode: 448
		});
		await writeFileAtomic(this.cacheFile, `${JSON.stringify(document)}\n`, {
			mode: 384,
			dirMode: 448
		});
	}
};
//#endregion
//#region src/index.ts
/** Stable Cordis plugin name. */
const name = "llm-xai-oauth";
/** LLM registry required before the subscription route can register. */
const inject = ["llm"];
const Config = z.object({});
/**
* Register the `xai-oauth` LLM route with a provider-native OAuth store.
* @param ctx - plugin context carrying the LLM registry plus optional web server.
*/
function apply(ctx, _config) {
	const session = new XaiOAuthSession(new XaiOAuthCredentialStore(), () => {
		ctx.emit("llm/adapters-updated");
	});
	session.loadCachedCatalog().then(() => session.refreshLiveCatalog()).catch(() => void 0);
	ctx.llm.registerAdapter([XAI_OAUTH_ROUTE], createXaiOAuthAdapter(session, () => ctx.get("attachments")));
	ctx.inject(["webServer"], (webCtx) => registerXaiOAuthAuthRoutes(webCtx, session));
}
//#endregion
export { Config, DEFAULT_XAI_OAUTH_MODEL, XAI_AUTH_HOSTS, XAI_MODELS_URL, XAI_OAUTH_AUTH_FILENAME, XAI_OAUTH_AUTH_IMPORT_PATH, XAI_OAUTH_AUTH_LOGIN_PATH, XAI_OAUTH_AUTH_LOGOUT_PATH, XAI_OAUTH_AUTH_MODELS_PATH, XAI_OAUTH_AUTH_STATUS_PATH, XAI_OAUTH_ROUTE, XAI_OAUTH_STREAM_IDLE_TIMEOUT_MS, XAI_PI_PROVIDER, XaiOAuthCredentialStore, XaiOAuthSession, apply, assertSafeAuthorizationUrl, createXaiOAuthAdapter, extractModelIds, fetchLiveModelIds, grokAuthPath, importGrokAuth, importXaiOAuthFromGrok, importXaiOAuthSession, inject, isLoopbackHost, isSelectableChatModel, isTerminalOAuthFailure, loginXaiOAuth, loginXaiOAuthSession, logoutXaiOAuth, materializeLiveModel, mergeLiveCatalog, name, parseGrokAuthDocument, preferredXaiOAuthModel, preferredXaiOAuthModelFrom, probeGrokAuth, registerXaiOAuthAuthRoutes, safeMessage, trustedRequest, xaiOAuthAuthPath, xaiOAuthAuthStatus };

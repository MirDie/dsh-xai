#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import "@deepseek-ai/dsh-llm";
import "@deepseek-ai/dsh-llm-pi-ai";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { createModels } from "@earendil-works/pi-ai";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
//#region src/ids.ts
/** Harness LLM route. Distinct from the catalog `xai` API-key route. */
const XAI_OAUTH_ROUTE = "xai-oauth";
/** Basename of the OAuth document inside the Harness home. */
const XAI_OAUTH_AUTH_FILENAME = ".xai-oauth-auth.json";
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
z.object({});
//#endregion
//#region src/bin.ts
/** Standalone credential CLI for the optional xAI Grok bundle. */
function openBrowser(rawUrl) {
	const href = assertSafeAuthorizationUrl(rawUrl);
	const url = new URL(href);
	const command = process.platform === "win32" ? {
		file: "rundll32.exe",
		args: ["url.dll,FileProtocolHandler", url.href]
	} : process.platform === "darwin" ? {
		file: "open",
		args: [url.href]
	} : {
		file: "xdg-open",
		args: [url.href]
	};
	try {
		const child = spawn(command.file, command.args, {
			detached: true,
			stdio: "ignore",
			windowsHide: true
		});
		child.on("error", () => {});
		child.unref();
	} catch {}
}
function notify(event, useBrowser) {
	switch (event.type) {
		case "auth_url":
			process.stdout.write(`Open this URL to sign in:\n${event.url}\n`);
			if (event.instructions !== void 0) process.stdout.write(`${event.instructions}\n`);
			if (useBrowser) openBrowser(event.url);
			break;
		case "device_code":
			process.stdout.write(`Open this URL to sign in:\n${event.verificationUri}\n`);
			if (event.userCode.length > 0) process.stdout.write(`Enter code: ${event.userCode}\n`);
			if (useBrowser) openBrowser(event.verificationUri);
			break;
		case "info":
		case "progress": process.stdout.write(`${event.message}\n`);
	}
}
async function answerPrompt(prompt, question) {
	if (prompt.type === "select") return prompt.options.find((option) => option.id === "oauth" || option.id.includes("oauth"))?.id ?? prompt.options[0]?.id ?? "oauth";
	const suffix = prompt.placeholder === void 0 ? "" : ` (${prompt.placeholder})`;
	return question(`${prompt.message}${suffix}: `, { ...prompt.signal === void 0 ? {} : { signal: prompt.signal } });
}
function printHelp() {
	process.stdout.write([
		"Usage: dsh-xai <login|logout|status|import>",
		"",
		"  login [--no-browser]  sign in with SuperGrok or X Premium (device code)",
		"  import  copy ~/.grok/auth.json into the dsh store (does not modify Grok CLI)",
		"  logout  remove the dsh credential without changing ~/.grok",
		"  status  report non-secret dsh credential state and visible models",
		""
	].join("\n"));
}
async function run(argv) {
	if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
		printHelp();
		return 0;
	}
	const [rawAction, ...flags] = argv;
	if (rawAction !== "login" && rawAction !== "logout" && rawAction !== "status" && rawAction !== "import") {
		process.stderr.write(`dsh-xai: expected login, logout, status, or import; got ${JSON.stringify(rawAction)}\n`);
		return 1;
	}
	const action = rawAction;
	const useBrowser = !flags.includes("--no-browser");
	if (flags.filter((flag) => flag !== "--no-browser").length > 0 || flags.includes("--no-browser") && action !== "login") {
		process.stderr.write(`dsh-xai: invalid options for ${action}: ${flags.join(" ")}\n`);
		return 1;
	}
	try {
		switch (action) {
			case "status": {
				const session = new XaiOAuthSession();
				await session.loadCachedCatalog();
				const status = await xaiOAuthAuthStatus(session.store);
				if (!status.authenticated) {
					process.stdout.write("xAI Grok for dsh: signed out\n");
					return 1;
				}
				await session.refreshLiveCatalog();
				const expires = status.expiresAt;
				const suffix = expires === void 0 || Number.isNaN(expires.valueOf()) ? "" : `; access token expires ${expires.toISOString()} (refresh is automatic)`;
				const models = session.visibleModels().map((model) => model.id).join(", ");
				process.stdout.write(`xAI Grok for dsh: signed in${suffix}\n`);
				process.stdout.write(`models (${session.catalogSource}): ${models}\n`);
				if (session.catalogError !== void 0) process.stderr.write(`dsh-xai: live /models failed: ${session.catalogError}\n`);
				return 0;
			}
			case "logout":
				await new XaiOAuthSession().logout();
				process.stdout.write(`xAI Grok for dsh: signed out; removed ${xaiOAuthAuthPath()}\n`);
				return 0;
			case "import": {
				const session = new XaiOAuthSession();
				await importXaiOAuthSession(session);
				process.stdout.write(`xAI Grok for dsh: imported ${grokAuthPath()} into ${xaiOAuthAuthPath()}\n`);
				process.stdout.write("The Grok CLI file was not modified. Later dsh refresh may rotate the token.\n");
				const models = session.visibleModels().map((model) => model.id).join(", ");
				process.stdout.write(`models (${session.catalogSource}): ${models}\n`);
				return 0;
			}
			case "login": {
				const session = new XaiOAuthSession();
				const readline = createInterface({
					input: process.stdin,
					output: process.stdout
				});
				try {
					await loginXaiOAuthSession({
						prompt: (prompt) => answerPrompt(prompt, (text, options) => readline.question(text, options)),
						notify: (event) => notify(event, useBrowser)
					}, session);
				} finally {
					readline.close();
				}
				process.stdout.write(`xAI Grok for dsh: signed in; credentials saved to ${xaiOAuthAuthPath()}\n`);
				process.stdout.write(`models (${session.catalogSource}): ${session.visibleModels().map((model) => model.id).join(", ")}\n`);
				return 0;
			}
		}
	} catch (error) {
		process.stderr.write(`dsh-xai: ${action} failed: ${safeMessage(error)}\n`);
		return 1;
	}
}
if (process.argv[1] !== void 0 && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) process.exitCode = await run(process.argv.slice(2));
//#endregion
export { run };

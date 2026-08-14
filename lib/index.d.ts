import z from "@deepseek-ai/schemastery";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { Api, AuthInteraction, Credential, CredentialInfo, CredentialStore, Model, MutableModels, OAuthCredential, Provider } from "@earendil-works/pi-ai";
import { Context } from "@deepseek-ai/cordis";
import { AttachmentStore } from "@deepseek-ai/dsh-attachment";
//#region src/catalog.d.ts
declare const XAI_MODELS_URL = "https://api.x.ai/v1/models";
type CatalogSource = 'live' | 'cache' | 'fallback';
/** Pull model ids from an OpenAI-shaped or gateway-shaped listing body. */
declare function extractModelIds(body: unknown): string[];
/** Turn a live id into a pi-ai model, inheriting catalog metadata when possible. */
declare function materializeLiveModel(id: string, catalog?: readonly Model<Api>[]): Model<Api>;
/**
 * If `liveIds` is missing or empty, serve the installed catalog.
 * Otherwise serve only the live ids, each materialized against the catalog.
 */
declare function mergeLiveCatalog(catalog: readonly Model<Api>[], liveIds: readonly string[] | undefined): Model<Api>[];
declare function preferredXaiOAuthModelFrom(models: readonly {
  id: string;
}[]): string;
/** Fetch the account-visible model ids. Throws a secret-free error on failure. */
declare function fetchLiveModelIds(accessToken: string, signal?: AbortSignal): Promise<string[]>;
//#endregion
//#region src/store.d.ts
/** Resolve the default OAuth document path. */
declare function xaiOAuthAuthPath(dshHome?: string): string;
/** File-backed pi-ai store scoped to the single xAI provider. */
declare class XaiOAuthCredentialStore implements CredentialStore {
  readonly filename: string;
  constructor(filename?: string);
  private readCurrent;
  read(providerId: string): Promise<Credential | undefined>;
  list(): Promise<readonly CredentialInfo[]>;
  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined>;
  delete(providerId: string): Promise<void>;
}
//#endregion
//#region src/session.d.ts
/** One process-local owner of the credential and the account model list. */
declare class XaiOAuthSession {
  readonly store: XaiOAuthCredentialStore;
  readonly models: MutableModels;
  private readonly baseline;
  private liveIds;
  private source;
  private listingError;
  private readonly cacheFile;
  constructor(store?: XaiOAuthCredentialStore);
  /** Secret-free listing diagnostic from the last refresh. */
  get catalogError(): string | undefined;
  get catalogSource(): CatalogSource;
  visibleModels(): Model<Api>[];
  /** Provider whose getModels() reflects the current live/cache/fallback list. */
  provider(): Provider;
  loadCachedCatalog(): Promise<void>;
  refreshLiveCatalog(signal?: AbortSignal): Promise<void>;
  logout(): Promise<void>;
  private writeCache;
}
//#endregion
//#region src/adapter.d.ts
/** Prefer grok-4.6 when the current (live or installed) list has it. */
declare function preferredXaiOAuthModel(models?: readonly {
  id: string;
}[]): string;
/**
 * Create the SuperGrok adapter without a dsh fork.
 * The public pi-ai adapter owns streaming, tools, reasoning, and compaction;
 * this plugin supplies a refreshable OAuth token and an account model list.
 */
declare function createXaiOAuthAdapter(session: XaiOAuthSession, resolveAttachments: () => AttachmentStore | undefined): PiAiAdapter;
//#endregion
//#region src/auth.d.ts
/** Non-secret login state shown by the launcher. */
interface XaiOAuthAuthStatus {
  authenticated: boolean;
  expiresAt?: Date;
}
/** Complete provider-native OAuth and persist the resulting credential. */
declare function loginXaiOAuth(interaction: AuthInteraction, store?: XaiOAuthCredentialStore): Promise<void>;
/** Copy ~/.grok/auth.json into the dsh store. Does not modify the Grok file. */
declare function importXaiOAuthFromGrok(store?: XaiOAuthCredentialStore, filename?: string): Promise<void>;
/** Remove the stored xAI OAuth credential. */
declare function logoutXaiOAuth(store?: XaiOAuthCredentialStore): Promise<void>;
/** Read non-secret login state without refreshing the token. */
declare function xaiOAuthAuthStatus(store?: XaiOAuthCredentialStore): Promise<XaiOAuthAuthStatus>;
/** Login then refresh the account model list when a session is available. */
declare function loginXaiOAuthSession(interaction: AuthInteraction, session: XaiOAuthSession): Promise<void>;
declare function importXaiOAuthSession(session: XaiOAuthSession, filename?: string): Promise<void>;
//#endregion
//#region src/auth-routes.d.ts
declare const XAI_OAUTH_AUTH_STATUS_PATH = "/plugins/dsh-xai/auth/status";
declare const XAI_OAUTH_AUTH_LOGIN_PATH = "/plugins/dsh-xai/auth/login";
declare const XAI_OAUTH_AUTH_IMPORT_PATH = "/plugins/dsh-xai/auth/import";
declare const XAI_OAUTH_AUTH_LOGOUT_PATH = "/plugins/dsh-xai/auth/logout";
type XaiOAuthWebAuthStatus = {
  status: 'signed-out';
  grokImportAvailable: boolean;
} | {
  status: 'signing-in';
  url?: string;
  userCode?: string;
  grokImportAvailable: boolean;
} | {
  status: 'signed-in';
  models: string[];
  catalogSource: CatalogSource;
  catalogError?: string;
  grokImportAvailable: boolean;
} | {
  status: 'error';
  message: string;
  grokImportAvailable: boolean;
};
interface LoginChallenge {
  url: string;
  userCode?: string;
}
/** Register the plugin-owned OAuth routes when the Web server is composed. */
declare function registerXaiOAuthAuthRoutes(ctx: Context, session: XaiOAuthSession): void;
//#endregion
//#region src/grok-import.d.ts
interface GrokImportProbe {
  available: boolean;
  path: string;
}
/** Resolve the Grok CLI auth document. */
declare function grokAuthPath(home?: string): string;
/** Parse a Grok CLI / generic OAuth document into a pi-ai credential. */
declare function parseGrokAuthDocument(text: string, filename: string): OAuthCredential;
/** Whether ~/.grok/auth.json exists and looks importable. Never returns secrets. */
declare function probeGrokAuth(filename?: string): Promise<GrokImportProbe>;
/** Copy Grok CLI tokens into the dsh store. Does not write the Grok file. */
declare function importGrokAuth(store: XaiOAuthCredentialStore, filename?: string): Promise<OAuthCredential>;
//#endregion
//#region src/ids.d.ts
/** pi-ai provider id used by login, refresh, and the credential store. */
declare const XAI_PI_PROVIDER = "xai";
/** Harness LLM route. Distinct from the catalog `xai` API-key route. */
declare const XAI_OAUTH_ROUTE = "xai-oauth";
/** Basename of the OAuth document inside the Harness home. */
declare const XAI_OAUTH_AUTH_FILENAME = ".xai-oauth-auth.json";
/** Fallback model when the installed pi-ai catalog has no grok-4.6. */
declare const DEFAULT_XAI_OAUTH_MODEL = "grok-4.5";
/** Provider idle ceiling used by the composite route. */
declare const XAI_OAUTH_STREAM_IDLE_TIMEOUT_MS = 300000;
//#endregion
//#region src/redact.d.ts
/** Remove token-like strings from an external OAuth diagnostic. */
declare function safeMessage(error: unknown): string;
//#endregion
//#region src/index.d.ts
/** Stable Cordis plugin name. */
declare const name = "llm-xai-oauth";
/** LLM registry required before the subscription route can register. */
declare const inject: string[];
/** Reserved for later knobs; the first release has no tunable fields. */
interface Config {}
declare const Config: z<Config>;
/**
 * Register the `xai-oauth` LLM route with a provider-native OAuth store.
 * @param ctx - plugin context carrying the LLM registry plus optional web server.
 */
declare function apply(ctx: Context, _config: Config): void;
//#endregion
export { type CatalogSource, Config, DEFAULT_XAI_OAUTH_MODEL, type GrokImportProbe, type LoginChallenge, XAI_MODELS_URL, XAI_OAUTH_AUTH_FILENAME, XAI_OAUTH_AUTH_IMPORT_PATH, XAI_OAUTH_AUTH_LOGIN_PATH, XAI_OAUTH_AUTH_LOGOUT_PATH, XAI_OAUTH_AUTH_STATUS_PATH, XAI_OAUTH_ROUTE, XAI_OAUTH_STREAM_IDLE_TIMEOUT_MS, XAI_PI_PROVIDER, type XaiOAuthAuthStatus, XaiOAuthCredentialStore, XaiOAuthSession, type XaiOAuthWebAuthStatus, apply, createXaiOAuthAdapter, extractModelIds, fetchLiveModelIds, grokAuthPath, importGrokAuth, importXaiOAuthFromGrok, importXaiOAuthSession, inject, loginXaiOAuth, loginXaiOAuthSession, logoutXaiOAuth, materializeLiveModel, mergeLiveCatalog, name, parseGrokAuthDocument, preferredXaiOAuthModel, preferredXaiOAuthModelFrom, probeGrokAuth, registerXaiOAuthAuthRoutes, safeMessage, xaiOAuthAuthPath, xaiOAuthAuthStatus };
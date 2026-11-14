// A Google access token from Application Default Credentials, minted without Google's client library (this package has
// no dependencies), for a Kubernetes API that takes one: GKE. GKE names a Google caller by its email only when the
// token carries the userinfo.email scope, so every token is asked for with it beside cloud-platform.
//
// The credentials are a file (the server's GOOGLE_APPLICATION_CREDENTIALS, or a path given) of one of three types. The
// metadata server of a Google machine is not asked: a server with no file is refused in words.
// - service_account: a JWT signed with its key, exchanged at its token_uri.
// - authorized_user: its refresh token, exchanged at Google's OAuth token endpoint (a person's gcloud login).
// - external_account: workload identity federation. A subject token read from credential_source (a file, or a URL with
//   its headers; text, or JSON with the field named), exchanged at token_url (Google's STS), then, with
//   service_account_impersonation_url, exchanged again for the service account's token. An executable or AWS source
//   is refused in words: it is not read here.
// A token is kept until a minute before it ends, and a fresh one is minted on a 401.
import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { BearerToken, TokenSource } from "./kubernetes-api.js";
import { fail, ok, type Result } from "./result.js";

/** Every token's scopes: cloud-platform, and userinfo.email, without which GKE does not see the caller's email. */
export const GKE_SCOPES = ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/userinfo.email"] as const;

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
/** A token is minted again this long before it ends. */
const EARLY_MS = 60_000;
const REQUEST_MS = 15_000;

export interface GoogleAdcOptions {
	/** The credentials file; absent, every token is refused in words. */
	credentialsFile?: string;
	/** For tests: every request goes through it. Default the global fetch. */
	fetch?: typeof fetch;
	/** For tests: what reads a file. */
	readFile?: (path: string) => Promise<string>;
	/** For tests: the clock. */
	now?: () => number;
}

interface CredentialSource {
	file?: string;
	url?: string;
	headers?: Record<string, string>;
	format?: { type?: string; subject_token_field_name?: string };
	executable?: unknown;
	environment_id?: string;
}

interface Credentials {
	type?: string;
	client_email?: string;
	private_key?: string;
	token_uri?: string;
	client_id?: string;
	client_secret?: string;
	refresh_token?: string;
	audience?: string;
	subject_token_type?: string;
	token_url?: string;
	service_account_impersonation_url?: string;
	credential_source?: CredentialSource;
	workforce_pool_user_project?: string;
}

const failure = (message: string) => fail("denied", `Google ADC: ${message}`);
/** A failure of Google's token service itself (5xx, unreachable): transient, so a failover may follow. */
const unavailable = (message: string): Result<never> => ({ ok: false, error: { code: "unreachable", message: `Google ADC: ${message}`, transient: true } });

async function post(fetcher: typeof fetch, url: string, body: URLSearchParams | object, headers: Record<string, string> = {}): Promise<Result<Record<string, unknown>>> {
	const what = `POST ${new URL(url).host}${new URL(url).pathname}`;
	let response: Response;
	let text: string;
	try {
		response = await fetcher(url, {
			method: "POST",
			headers: body instanceof URLSearchParams ? { "Content-Type": "application/x-www-form-urlencoded", ...headers } : { "Content-Type": "application/json", ...headers },
			body: body instanceof URLSearchParams ? body.toString() : JSON.stringify(body),
			redirect: "error",
			signal: AbortSignal.timeout(REQUEST_MS),
		});
		// The body inside the same try: a body that stalls or drops is the same outage as no answer.
		text = await response.text();
	} catch (cause) {
		return unavailable(`${what} failed: ${(cause as Error).message}`);
	}
	if (response.status >= 500 || response.status === 429) return unavailable(`${what}: ${response.status} ${text.slice(0, 300)}`);
	// The token service's own words (error, error_description), never the request's: it held a token or a key.
	if (!response.ok) return failure(`${what}: ${response.status} ${text.replace(/\s+/g, " ").slice(0, 300)}`);
	try {
		return ok(JSON.parse(text) as Record<string, unknown>);
	} catch {
		return failure(`${what} answered what is not JSON`);
	}
}

/** The token of an OAuth answer ({ access_token, expires_in }), or an impersonation's ({ accessToken, expireTime }). */
function tokenOf(answer: Record<string, unknown>, now: number, what: string): Result<BearerToken> {
	const token = answer.access_token ?? answer.accessToken;
	if (typeof token !== "string" || token === "") return failure(`${what} answered no access token`);
	const seconds = Number(answer.expires_in);
	const expireTime = typeof answer.expireTime === "string" ? Date.parse(answer.expireTime) : Number.NaN;
	const expiresAt = Number.isFinite(seconds) && seconds > 0 ? now + seconds * 1000 : Number.isFinite(expireTime) ? expireTime : undefined;
	return ok({ token, ...(expiresAt === undefined ? {} : { expiresAt }) });
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

/** A service account's token: an RS256 JWT for its token_uri, with the scopes. */
async function serviceAccount(credentials: Credentials, fetcher: typeof fetch, now: number): Promise<Result<BearerToken>> {
	const { client_email: email, private_key: key, token_uri: tokenUri = OAUTH_TOKEN_URL } = credentials;
	if (typeof email !== "string" || typeof key !== "string") return failure("the service_account credentials have no client_email or private_key");
	const issued = Math.floor(now / 1000);
	const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify({ iss: email, scope: GKE_SCOPES.join(" "), aud: tokenUri, iat: issued, exp: issued + 3600 }))}`;
	let signature: string;
	try {
		signature = createSign("RSA-SHA256").update(unsigned).sign(key, "base64url");
	} catch {
		return failure("the service_account's private_key could not sign: it is not a PEM private key");
	}
	const answer = await post(fetcher, tokenUri, new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }));
	return answer.ok ? tokenOf(answer.value, now, "the service account's token exchange") : answer;
}

/** A person's gcloud login: its refresh token exchanged. Its scopes are the login's own (gcloud's include both). */
async function authorizedUser(credentials: Credentials, fetcher: typeof fetch, now: number): Promise<Result<BearerToken>> {
	const { client_id: id, client_secret: secret, refresh_token: refresh } = credentials;
	if (typeof id !== "string" || typeof secret !== "string" || typeof refresh !== "string") return failure("the authorized_user credentials have no client_id, client_secret or refresh_token");
	const answer = await post(fetcher, OAUTH_TOKEN_URL, new URLSearchParams({ grant_type: "refresh_token", client_id: id, client_secret: secret, refresh_token: refresh }));
	return answer.ok ? tokenOf(answer.value, now, "the refresh token's exchange") : answer;
}

/** The subject token of an external account: its file's or its URL's, as text or a JSON field. */
async function subjectToken(source: CredentialSource, fetcher: typeof fetch, read: (path: string) => Promise<string>): Promise<Result<string>> {
	if (source.executable !== undefined) return failure("an external_account whose credential_source is an executable is not read here: give one whose source is a file or a URL");
	if (source.environment_id !== undefined) return failure("an external_account whose credential_source is AWS is not read here: give one whose source is a file or a URL");
	let raw: string;
	if (typeof source.file === "string") {
		try {
			raw = await read(source.file);
		} catch (cause) {
			return failure(`the external_account's subject token file ${source.file} could not be read: ${(cause as NodeJS.ErrnoException).code ?? (cause as Error).message}`);
		}
	} else if (typeof source.url === "string") {
		try {
			const response = await fetcher(source.url, { headers: source.headers ?? {}, redirect: "error", signal: AbortSignal.timeout(REQUEST_MS) });
			raw = await response.text();
			if (!response.ok) return response.status >= 500 ? unavailable(`the subject token URL answered ${response.status}`) : failure(`the subject token URL answered ${response.status}`);
		} catch (cause) {
			return unavailable(`the subject token URL could not be read: ${(cause as Error).message}`);
		}
	} else return failure("the external_account's credential_source names no file and no URL");
	if (source.format?.type === "json") {
		const field = source.format.subject_token_field_name;
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return failure("the subject token is not the JSON its credential_source format says");
		}
		const token = typeof field === "string" ? (parsed as Record<string, unknown> | null)?.[field] : undefined;
		return typeof token === "string" && token !== "" ? ok(token) : failure(`the subject token's JSON has no field ${JSON.stringify(field)}`);
	}
	const token = raw.trim();
	return token === "" ? failure("the subject token is empty") : ok(token);
}

/** Workload identity federation: the subject token exchanged at Google's STS, then for the service account's token when impersonating. */
async function externalAccount(credentials: Credentials, fetcher: typeof fetch, read: (path: string) => Promise<string>, now: number): Promise<Result<BearerToken>> {
	const { audience, subject_token_type: type, token_url: tokenUrl, service_account_impersonation_url: impersonate, credential_source: source } = credentials;
	if (typeof audience !== "string" || typeof type !== "string" || typeof tokenUrl !== "string" || source === undefined) return failure("the external_account credentials have no audience, subject_token_type, token_url or credential_source");
	if (credentials.workforce_pool_user_project !== undefined) return failure("a workforce pool's external_account is not read here: give a workload identity pool's");
	const subject = await subjectToken(source, fetcher, read);
	if (!subject.ok) return subject;
	// Impersonating: the STS token needs cloud-platform alone; the scopes go on the service account's token.
	const exchanged = await post(
		fetcher,
		tokenUrl,
		new URLSearchParams({ grant_type: TOKEN_EXCHANGE, audience, scope: impersonate ? GKE_SCOPES[0] : GKE_SCOPES.join(" "), requested_token_type: ACCESS_TOKEN_TYPE, subject_token: subject.value, subject_token_type: type }),
	);
	if (!exchanged.ok) return exchanged;
	const federated = tokenOf(exchanged.value, now, "Google's STS token exchange");
	if (!federated.ok || impersonate === undefined) return federated;
	const impersonated = await post(fetcher, impersonate, { scope: [...GKE_SCOPES], lifetime: "3600s" }, { Authorization: `Bearer ${federated.value.token}` });
	return impersonated.ok ? tokenOf(impersonated.value, now, "the service account's impersonation") : impersonated;
}

/**
 * A TokenSource of Google access tokens with GKE's scopes, from the credentials file. A token is
 * kept until a minute before it ends; a fresh one is minted when asked (after a 401). Never prints a token or a key.
 */
export function googleAdc(options: GoogleAdcOptions = {}): TokenSource {
	const fetcher = options.fetch ?? fetch;
	const read = options.readFile ?? ((path: string) => readFile(path, "utf8"));
	const clock = options.now ?? Date.now;
	let kept: BearerToken | undefined;
	let minting: Promise<Result<BearerToken>> | undefined;
	const mint = async (): Promise<Result<BearerToken>> => {
		const now = clock();
		if (options.credentialsFile === undefined || options.credentialsFile === "") return failure("no credentials file is given: set GOOGLE_APPLICATION_CREDENTIALS (or KUBERNETES_GOOGLE_CREDENTIALS) to a service_account, authorized_user or external_account file; the metadata server is not asked");
		let credentials: Credentials;
		try {
			credentials = JSON.parse(await read(options.credentialsFile)) as Credentials;
		} catch (cause) {
			return failure(`the credentials file ${options.credentialsFile} could not be read as JSON: ${(cause as NodeJS.ErrnoException).code ?? "not JSON"}`);
		}
		switch (credentials?.type) {
			case "service_account":
				return serviceAccount(credentials, fetcher, now);
			case "authorized_user":
				return authorizedUser(credentials, fetcher, now);
			case "external_account":
				return externalAccount(credentials, fetcher, read, now);
			default:
				return failure(`the credentials file is of type ${JSON.stringify(credentials?.type)}: service_account, authorized_user and external_account are read`);
		}
	};
	return async (fresh) => {
		if (!fresh && kept !== undefined && (kept.expiresAt === undefined || kept.expiresAt - EARLY_MS > clock())) return ok(kept);
		minting ??= mint().finally(() => (minting = undefined));
		const got = await minting;
		if (got.ok) kept = got.value;
		return got;
	};
}

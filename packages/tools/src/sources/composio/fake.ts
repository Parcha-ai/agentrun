// A fake Composio for the adapter's conformance cases: its API's exchanges as the API reference states them
// (https://docs.composio.dev/reference/api-reference, read 2026-11-10; to be replaced by recorded, redacted ones with the
// live smoke, TP-14), served by a fetch that never leaves this process. It keeps each request (where it went, whether it
// carried the key, its body), and answers a fault a test sets on a path: a status, a hang, a redirect, or an echo of the
// key in every place an answer can carry it.

export const FAKE_KEY = "fake-test-key-composio-0123456789";
export const PINNED = "20250909_00";

export type Fault =
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | "hang"
  | "redirect"
  | "echo"
  | "unreachable";

export type Seen = { method: string; origin: string; path: string; query: Record<string, string>; key: string | null; body: unknown };

type Account = { id: string; toolkit: string; status: string; authConfig: string };

const json = (status: number, doc: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(doc), { status, headers: { "content-type": "application/json", ...headers } });

const tool = (toolkit: string, slug: string, extra: Record<string, unknown> = {}) => ({
  slug,
  name: slug.toLowerCase().replace(/_/g, " "),
  description: `${slug} on ${toolkit}.`,
  toolkit: { slug: toolkit, name: toolkit, logo: "https://logos.example/x.png" },
  input_parameters: { type: "object", properties: { to: { type: "string" } } },
  output_parameters: { type: "object" },
  version: PINNED,
  available_versions: [PINNED],
  tags: [],
  no_auth: false,
  is_deprecated: false,
  ...extra,
});

/** The catalog the fake lists: two toolkits with accounts to connect, one without, and Composio's own meta toolkit. */
const TOOLS = [
  tool("gmail", "GMAIL_SEND_EMAIL"),
  tool("gmail", "GMAIL_FETCH_EMAILS", { tags: ["readOnlyHint"] }),
  tool("gmail", "GMAIL_DELETE_MESSAGE", { tags: ["destructiveHint"] }),
  tool("gmail", "GMAIL_BETA_THING", { version: "latest", available_versions: ["latest"] }),
  tool("hackernews", "HACKERNEWS_GET_TOP", { no_auth: true, tags: ["readOnlyHint"] }),
  tool("composio", "COMPOSIO_MULTI_EXECUTE_TOOL"),
];
const TOOLKITS = [
  { slug: "gmail", name: "Gmail", no_auth: false, meta: { tools_count: 4, version: PINNED } },
  { slug: "hackernews", name: "Hacker News", no_auth: true, meta: { tools_count: 1, version: PINNED } },
  { slug: "composio", name: "Composio", no_auth: true, meta: { tools_count: 1, version: PINNED } },
];

export function fakeComposio({ key = FAKE_KEY }: { key?: string } = {}) {
  const seen: Seen[] = [];
  const faults = new Map<string, Fault>();
  const accounts = new Map<string, Account>([["ca_active", { id: "ca_active", toolkit: "gmail", status: "ACTIVE", authConfig: "ac_gmail" }]]);
  const authConfigs: { id: string; toolkit: string; managed: boolean }[] = [];
  let made = 0;

  /** A fault on `path` (the API path after /api/v3.1, method first: "POST /tools/execute/GMAIL_SEND_EMAIL"), or none. */
  const faultOf = (method: string, path: string): Fault | undefined => faults.get(`${method} ${path}`) ?? faults.get(path);

  const fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const path = url.pathname.replace(/^\/api\/v3\.1/, "");
    seen.push({ method, origin: url.origin, path, query: Object.fromEntries(url.searchParams), key: headers.get("x-api-key"), body });
    const signal = init.signal ?? undefined;
    if (signal?.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
    const fault = faultOf(method, path);
    if (fault === "unreachable") throw new TypeError("fetch failed (connect ECONNREFUSED)");
    if (fault === "hang") {
      return await new Promise<Response>((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason ?? new DOMException("aborted", "AbortError")), { once: true });
      });
    }
    // The key in every place an answer can carry it: a header, the body, a redirect's URL and its query.
    if (fault === "redirect") return new Response(null, { status: 302, headers: { location: `https://elsewhere.example/steal?key=${key}` } });
    if (fault === "echo") return json(500, { error: { message: `bad key ${headers.get("x-api-key")}`, code: 500, slug: "Echo", status: 500 }, key: headers.get("x-api-key") }, { "x-echo": headers.get("x-api-key") ?? "" });
    if (fault) return json(fault.status, fault.body ?? { error: { message: `fault ${fault.status}`, code: fault.status, slug: "Fault", status: fault.status } }, fault.headers);

    if (url.origin !== "https://backend.composio.dev" || !url.pathname.startsWith("/api/v3.1/")) return json(404, { error: { message: "Not Found", code: 404, slug: "NotFound", status: 404 } });
    if (headers.get("x-api-key") !== key) return json(401, { error: { message: "Invalid API key", code: 401, slug: "Unauthorized", status: 401 } });

    if (method === "GET" && path === "/toolkits") {
      const search = url.searchParams.get("search");
      const items = TOOLKITS.filter((t) => !search || t.slug.includes(search) || t.name.toLowerCase().includes(search.toLowerCase()));
      const limit = Number(url.searchParams.get("limit") ?? 1000);
      return json(200, { items: items.slice(0, limit), next_cursor: null, total_pages: 1, current_page: 1, total_items: items.length });
    }
    if (method === "GET" && path === "/tools") {
      const kit = url.searchParams.get("toolkit_slug");
      const slugs = url.searchParams.get("tool_slugs")?.split(",");
      const query = url.searchParams.get("query");
      const items = TOOLS.filter((t) => (!kit || t.toolkit.slug === kit) && (!slugs || slugs.includes(t.slug)) && (!query || t.description.toLowerCase().includes(query.toLowerCase())));
      // Two pages: the first item alone, then the rest, so a reader follows the cursor.
      const cursor = url.searchParams.get("cursor");
      const page = cursor === "page-2" ? items.slice(1) : items.slice(0, 1);
      return json(200, { items: page, next_cursor: cursor || items.length <= 1 ? null : "page-2", total_pages: items.length > 1 ? 2 : 1, current_page: cursor ? 2 : 1, total_items: items.length });
    }
    const executing = /^\/tools\/execute\/([A-Z0-9_]+)$/.exec(path);
    if (method === "POST" && executing) {
      const found = TOOLS.find((t) => t.slug === executing[1]);
      if (!found) return json(404, { error: { message: "Tool not found", code: 404, slug: "ToolNotFound", status: 404 } });
      if (body?.version !== found.version || found.version === "latest") return json(400, { error: { message: `version ${body?.version} is not ${found.slug}'s`, code: 400, slug: "BadVersion", status: 400 } });
      if (!found.no_auth) {
        const account = accounts.get(String(body?.connected_account_id ?? ""));
        if (!account) return json(404, { error: { message: "Connected account not found", code: 404, slug: "ConnectedAccountNotFound", status: 404 } });
        if (account.status !== "ACTIVE") return json(422, { error: { message: `Connected account is ${account.status}`, code: 422, slug: "ConnectedAccountInvalid", status: 422 } });
      }
      return json(200, { data: { slug: found.slug, arguments: body?.arguments ?? {} }, error: null, successful: true, log_id: `log_${seen.length}` });
    }
    if (method === "GET" && path === "/auth_configs") {
      const kit = url.searchParams.get("toolkit_slug");
      const items = authConfigs.filter((c) => !kit || c.toolkit === kit).map((c) => ({ id: c.id, toolkit: { slug: c.toolkit }, is_composio_managed: c.managed, is_disabled: false }));
      return json(200, { items, next_cursor: null });
    }
    if (method === "POST" && path === "/auth_configs") {
      const id = `ac_${body?.toolkit?.slug}_${++made}`;
      authConfigs.push({ id, toolkit: body?.toolkit?.slug, managed: body?.auth_config?.type === "use_composio_managed_auth" });
      return json(201, { toolkit: { slug: body?.toolkit?.slug }, auth_config: { id, auth_scheme: "OAUTH2", is_composio_managed: true } });
    }
    if (method === "POST" && path === "/connected_accounts/link") {
      const config = authConfigs.find((c) => c.id === body?.auth_config_id);
      if (!config) return json(404, { error: { message: "Auth config not found", code: 404, slug: "AuthConfigNotFound", status: 404 } });
      const id = `ca_new_${++made}`;
      accounts.set(id, { id, toolkit: config.toolkit, status: "INITIATED", authConfig: config.id });
      return json(201, { link_token: `lt_${id}`, redirect_url: `https://connect.composio.dev/link/lt_${id}`, expires_at: "2026-11-10T12:10:00.000Z", connected_account_id: id });
    }
    const account = /^\/connected_accounts\/([A-Za-z0-9_]+)$/.exec(path);
    if (account) {
      const found = accounts.get(account[1]!);
      if (!found) return json(404, { error: { message: "Connected account not found", code: 404, slug: "ConnectedAccountNotFound", status: 404 } });
      if (method === "GET") return json(200, { id: found.id, status: found.status, toolkit: { slug: found.toolkit }, auth_config: { id: found.authConfig, is_composio_managed: true, is_disabled: false } });
      if (method === "DELETE") {
        accounts.delete(found.id);
        return json(200, { success: true });
      }
    }
    return json(404, { error: { message: "Not Found", code: 404, slug: "NotFound", status: 404 } });
  };

  return { fetch: fetch as typeof globalThis.fetch, seen, faults, accounts, authConfigs };
}

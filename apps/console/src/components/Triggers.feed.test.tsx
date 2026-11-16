import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { SchedulesPage } from "./Schedules";
import { createClient } from "@/lib/client";
import { when } from "@/lib/format";
import type { Firing, Trigger } from "@/lib/v2";
import { pick, picker } from "@/test/picker";

// A feed trigger (serve's trigger-feed.ts) from the console: the list offers it and says each feed trigger's last check
// (ok or failed, its words, when); its form takes 1 to 20 URLs a line, how often they are read (at least the server's
// floor), a JSON list's items and id pointers behind a disclosure, and "Only when" conditions on the item; a create lands
// on the trigger's page, which says its first check and the note of what it starts from; Edit sends the feeds, the
// interval, the pointers and the filter as a PATCH, and says that a feed added starts from now.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STATUS = "https://status.example.com/history.atom";
const BLOG = "https://blog.example.org/feed.xml";
const PULLS = "https://api.github.com/repos/acme/app/pulls";
const CHECKED = "2026-11-16T11:05:00Z";

const BASE: Omit<Trigger, "id" | "name" | "source"> = {
  enabled: true, target: { kind: "start_run", agent_id: "triage", input: { content: "Say what changed." }, max_cost_usd: 1 },
  catchup_window_s: 0, max_active_runs: null, failures_in_a_row: 0, disabled: null, last_run_id: null,
  created_at: "2026-11-16T11:00:00Z", updated_at: "2026-11-16T11:00:00Z", next_at: "2026-11-16T11:15:00Z", last_firing: null,
};
const FEED: Trigger = {
  ...BASE, id: "trg_f", name: "vendor outages", source: { kind: "feed", urls: [STATUS, BLOG], every_s: 900, accept: [{ event: "item", where: [{ pointer: "/title", prefix: "[outage]" }] }] },
  last_check: { at: CHECKED, ok: true, message: "Read 2 feeds: 1 new." },
};
const DOWN: Trigger = {
  ...BASE, id: "trg_d", name: "release notes", source: { kind: "feed", urls: [BLOG], every_s: 3600 },
  last_check: { at: CHECKED, ok: false, message: `Couldn't read ${BLOG}: HTTP 503.` },
};
const STOPPED: Trigger = {
  ...BASE, id: "trg_s", name: "old status", enabled: false, next_at: null, source: { kind: "feed", urls: [STATUS], every_s: 900 },
  disabled: { reason: "source_unreadable", detail: `Every feed it reads has stopped: ${STATUS} is gone (HTTP 410). Edit its urls, then turn it on again.`, at: CHECKED },
  last_check: { at: CHECKED, ok: false, message: `${STATUS} is gone (HTTP 410): it is no longer read; edit the trigger's urls to drop or fix it.` },
};
const LIST: Trigger = {
  ...BASE, id: "trg_l", name: "new pulls", source: { kind: "feed", urls: [PULLS], every_s: 300, items: "", id: "/number" },
  last_check: { at: CHECKED, ok: true, message: "Read app/pulls: 0 new." },
};
const NOTE = "Watching 2 feeds from now: the 130 items already there won't start runs.";
const noted = (over: Partial<Firing>): Firing => ({ key: "fir_n", by: "feed", nominal_at: CHECKED, status: "skipped", at: CHECKED, run_id: null, reason: NOTE, error: null, ...over });
const AGENTS = [{ agent_id: "triage", kind: "agentic", definition: { name: "Triage" }, archived_at: null }];

type Call = { method: string; path: string; body: unknown; key: string | null };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// A create answers the trigger with its first check read (serve waits for the first poll), and keeps it, with the note
// of its start as its one firing, so its page opens on it.
function server({ triggers = [FEED, DOWN], create }: { triggers?: Trigger[]; create?: (call: Call) => Response } = {}) {
  const calls: Call[] = [];
  triggers = triggers.map((t) => structuredClone(t));
  const firings: Record<string, Firing[]> = {};
  const fetch = (async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", path: new URL(String(url), "http://serve.test").pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined, key: new Headers(init?.headers).get("idempotency-key") };
    calls.push(call);
    if (call.path === "/v2/agents") return json(200, { agents: AGENTS, next_cursor: null });
    if (call.path === "/v2/triggers" && call.method === "GET") return json(200, { triggers });
    if (call.path === "/v2/triggers" && call.method === "POST") {
      if (create) return create(call);
      const made = { ...BASE, ...(call.body as object), id: "trg_new", last_check: { at: CHECKED, ok: true, message: "Watching 2 feeds." } } as Trigger;
      triggers.push(made);
      firings.trg_new = [noted({})];
      return json(201, made);
    }
    const m = /^\/v2\/triggers\/([^/]+)(\/firings|\/fire)?$/.exec(call.path);
    const t = m && triggers.find((x) => x.id === decodeURIComponent(m[1]));
    if (m && !t) return json(404, { error: { code: "not_found", message: "no trigger", retryable: false } });
    if (m?.[2] === "/firings") return json(200, { firings: firings[t!.id] ?? [] });
    if (m && call.method === "PATCH") { Object.assign(t!, call.body); return json(200, t); }
    if (m) return json(200, t);
    return json(404, { error: { code: "not_found", message: call.path, retryable: false } });
  }) as typeof globalThis.fetch;
  return { v2: createClient({ fetch }), calls };
}

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

async function open(v2: ReturnType<typeof createClient>, view: Parameters<typeof SchedulesPage>[0]["view"], minEvery?: number) {
  act(() => root?.unmount());
  document.body.innerHTML = "";
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const went: string[] = [];
  act(() => root!.render(createElement(SchedulesPage, { v2, view, go: (h: string) => void went.push(h), agentName: (id: string) => (id === "triage" ? "Triage" : id), minEvery })));
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await settle();
  const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()));
  const click = async (label: RegExp) => { await act(async () => { button(label)!.click(); }); await settle(); };
  const field = (name: string) => host.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLTextAreaElement | null;
  const set = async (name: string, value: string) => {
    if (name === "agent") return pick(picker(host, "Agent")!, value);
    if (name === "everyUnit") return pick(picker(host, "Unit")!, value);
    const el = field(name)!;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    await act(async () => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  const issue = (name: string) => host.querySelector(`[data-issue="${name}"]`)?.textContent ?? null;
  return { host, went, button, click, set, field, issue, settle, text: () => host.textContent ?? "" };
}

/** Fills a new feed trigger's run: its agent, what each run is asked, and its cap. */
async function fillRun(t: Awaited<ReturnType<typeof open>>) {
  await t.set("agent", "triage");
  await t.set("content", "Say what changed.");
  await t.set("maxCost", "1");
}

describe("Triggers: a feed trigger's list row and first trigger card", () => {
  it("offers New feed trigger, and says each feed trigger's last check: ok or failed, its words, and when", async () => {
    const t = await open(server().v2, {});
    const rows = Object.fromEntries([...t.host.querySelectorAll("[data-trigger]")].map((r) => [r.getAttribute("data-trigger"), r]));
    expect(rows.trg_f!.textContent).toContain("Feed");
    const ok = rows.trg_f!.querySelector("[data-last-check]")!;
    expect(ok.getAttribute("data-last-check")).toBe("ok");
    expect(ok.textContent).toContain("Read 2 feeds: 1 new.");
    expect(ok.textContent).toContain(when(CHECKED));
    const failed = rows.trg_d!.querySelector("[data-last-check]")!;
    expect(failed.getAttribute("data-last-check")).toBe("failed");
    expect(failed.textContent).toContain(`Couldn't read ${BLOG}: HTTP 503.`);
    expect(failed.textContent).toContain(when(CHECKED));
    await t.click(/^New feed trigger$/);
    expect(t.went).toEqual(["#/triggers/new-feed"]);
  });

  it("a server with no trigger yet offers a feed trigger among the first ones", async () => {
    const t = await open(server({ triggers: [] }).v2, {});
    const card = [...t.host.querySelectorAll("section[aria-labelledby=first-trigger] li")].find((li) => /^Feed/.test(li.textContent ?? ""))!;
    expect(card.textContent).toContain("New feed trigger");
    await t.click(/^New feed trigger$/);
    expect(t.went).toEqual(["#/triggers/new-feed"]);
  });
});

describe("Triggers: a new feed trigger", () => {
  it("says what is wrong with the URLs, a line at a time, and an interval under the server's floor, and sends nothing", async () => {
    const s = server();
    const t = await open(s.v2, { trigger: null, kind: "feed" }, 60);
    await fillRun(t);
    await t.click(/^Create feed trigger$/);
    expect(t.issue("source.urls")).toBe("Add a feed's URL, one a line.");
    await t.set("urls", Array.from({ length: 21 }, (_, i) => `https://status.example.com/${i}.atom`).join("\n"));
    await t.click(/^Create feed trigger$/);
    expect(t.issue("source.urls")).toBe("20 feeds at most: this has 21.");
    // Blank lines and the spaces around a URL are not feeds: the issues name each URL's place in the list sent.
    await t.set("urls", `${STATUS}\n\n  ftp://files.example.com/feed.xml  \nnot a url\n${STATUS}`);
    await t.set("every", "0.5");
    await t.click(/^Create feed trigger$/);
    expect(t.issue("source.urls")).toBeNull();
    expect(t.issue("source.urls[0]")).toBeNull();
    expect(t.issue("source.urls[1]")).toBe("ftp://files.example.com/feed.xml isn't an http or https URL.");
    expect(t.issue("source.urls[2]")).toBe("not a url isn't an http or https URL.");
    expect(t.issue("source.urls[3]")).toBe(`${STATUS} is here twice: each feed is read once.`);
    expect(t.issue("source.every_s")).toBe("At least a minute.");
    expect(s.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("sends the feeds read every 15 minutes by default, with nothing of a JSON list or a filter, under an Idempotency-Key", async () => {
    const s = server();
    const t = await open(s.v2, { trigger: null, kind: "feed" }, 60);
    await t.set("name", "vendor outages");
    await t.set("urls", `  ${STATUS}\n\n${BLOG}\n`);
    await fillRun(t);
    await t.click(/^Create feed trigger$/);
    const made = s.calls.find((c) => c.method === "POST" && c.path === "/v2/triggers")!;
    expect(made.key).toMatch(/.+/);
    expect(made.body).toEqual({ name: "vendor outages", source: { kind: "feed", urls: [STATUS, BLOG], every_s: 900 }, target: { kind: "start_run", agent_id: "triage", input: { content: "Say what changed." }, max_cost_usd: 1 } });
    // The create lands on the trigger's page, which says its first check.
    expect(t.went).toEqual(["#/triggers/trg_new"]);
  });

  it("sends a JSON list's items and id pointers from behind its disclosure, the interval in seconds, and Only when as the item's filter", async () => {
    const s = server();
    const t = await open(s.v2, { trigger: null, kind: "feed" }, 60);
    const list = t.host.querySelector("details[data-json-list]") as HTMLDetailsElement;
    expect(list.querySelector("summary")!.textContent).toContain("JSON list");
    expect(list.open).toBe(false);
    await t.set("urls", PULLS);
    await t.set("every", "2");
    await t.set("everyUnit", "hours");
    await t.set("items", "/data");
    await t.set("id", "/number");
    await t.click(/^Add a condition$/);
    await t.set("feed-where-0-pointer", "/title");
    await act(async () => { (t.host.querySelector('[name="feed-where-0-op"][value="prefix"]') as HTMLInputElement).click(); });
    await t.set("feed-where-0-value", "[outage]");
    await fillRun(t);
    await t.click(/^Create feed trigger$/);
    const made = s.calls.find((c) => c.method === "POST" && c.path === "/v2/triggers")!;
    expect((made.body as { source: unknown }).source).toEqual({ kind: "feed", urls: [PULLS], every_s: 7200, items: "/data", id: "/number", accept: [{ event: "item", where: [{ pointer: "/title", prefix: "[outage]" }] }] });
  });

  it("says a refused URL under the URLs, in the server's words", async () => {
    const said = `a feed URL is http or https, with no user or password in it: user@blog.example.org's holds one`;
    const s = server({ create: () => json(422, { error: { code: "input_invalid", message: `source.urls[1]: ${said}`, retryable: false, fields: [{ field: "source.urls[1]", reason: "invalid", message: said }] } }) });
    const t = await open(s.v2, { trigger: null, kind: "feed" }, 60);
    await t.set("urls", `${STATUS}\n${BLOG}`);
    await fillRun(t);
    await t.click(/^Create feed trigger$/);
    expect(t.issue("source.urls[1]")).toBe(said);
    expect(t.went).toEqual([]);
  });
});

describe("Triggers: a feed trigger's page", () => {
  it("after a create, says its first check and the note of what it starts from, with its feeds and interval", async () => {
    const s = server();
    const t = await open(s.v2, { trigger: null, kind: "feed" }, 60);
    await t.set("name", "vendor outages");
    await t.set("urls", `${STATUS}\n${BLOG}`);
    await fillRun(t);
    await t.click(/^Create feed trigger$/);
    const page = await open(s.v2, { trigger: "trg_new" });
    expect(page.text()).not.toContain("this page doesn't open it yet");
    expect(page.host.querySelector("h1")!.textContent).toContain("vendor outages");
    expect(page.text()).toContain("Feed · On each new item in 2 feeds");
    const check = page.host.querySelector('section[aria-label="Last check"]')!;
    expect(check.getAttribute("data-last-check")).toBe("ok");
    expect(check.textContent).toContain("Watching 2 feeds.");
    expect(check.textContent).toContain(when(CHECKED));
    expect(check.textContent).toContain(NOTE);
    const dl = page.host.querySelector("dl")!;
    expect(dl.textContent).toContain(STATUS);
    expect(dl.textContent).toContain(BLOG);
    expect(dl.textContent).toContain("Every 15 minutes");
    await page.click(/^Edit feed$/);
    expect(page.went).toEqual(["#/triggers/trg_new/edit"]);
  });

  it("says a failed check as failed, and a JSON list's pointers and its filter", async () => {
    const t = await open(server({ triggers: [DOWN, LIST, FEED] }).v2, { trigger: "trg_d" });
    const check = t.host.querySelector('section[aria-label="Last check"]')!;
    expect(check.getAttribute("data-last-check")).toBe("failed");
    expect(check.textContent).toContain(`Couldn't read ${BLOG}: HTTP 503.`);
    const list = await open(server({ triggers: [LIST] }).v2, { trigger: "trg_l" });
    const dl = list.host.querySelector("dl")!.textContent!;
    expect(dl).toContain("Items at the whole document");
    expect(dl).toContain("Id at /number");
    const filtered = await open(server({ triggers: [FEED] }).v2, { trigger: "trg_f" });
    expect(filtered.host.querySelector("dl")!.textContent).toContain("item where /title starts with");
  });

  it("a feed trigger turned off because every feed stopped says the stopped feed's words, and to edit its feeds", async () => {
    const t = await open(server({ triggers: [STOPPED] }).v2, { trigger: "trg_s" });
    expect(t.host.querySelector("[data-disabled]")!.textContent).toContain("Edit its feeds, then Resume.");
    expect(t.host.querySelector('section[aria-label="Last check"]')!.textContent).toContain("is gone (HTTP 410): it is no longer read");
  });
});

describe("Triggers: editing a feed trigger", () => {
  it("sends the kept feeds and an added one as a PATCH of its source alone, and says a feed added starts from now", async () => {
    const s = server({ triggers: [FEED] });
    const t = await open(s.v2, { trigger: "trg_f", edit: true }, 60);
    expect(t.host.querySelector("h1")!.textContent).toContain("Edit feed");
    expect(t.field("urls")!.value).toBe(`${STATUS}\n${BLOG}`);
    expect(t.text()).toContain("A feed you add starts from now: what's in it already won't start runs.");
    expect((t.field("feed-where-0-pointer") as HTMLInputElement).value).toBe("/title");
    await t.set("urls", `${STATUS}\n${BLOG}\n${PULLS}`);
    await t.click(/^Save feed$/);
    const patch = s.calls.find((c) => c.method === "PATCH")!;
    expect(patch.path).toBe("/v2/triggers/trg_f");
    // The added feed is sent beside the kept ones, as they were: the server takes its start at its first read.
    expect(patch.body).toEqual({ source: { kind: "feed", urls: [STATUS, BLOG, PULLS], every_s: 900, accept: [{ event: "item", where: [{ pointer: "/title", prefix: "[outage]" }] }] } });
    expect(t.went).toEqual(["#/triggers/trg_f"]);
  });

  it("sends the interval, the pointers and an emptied filter, and nothing at all when nothing changed", async () => {
    const s = server({ triggers: [FEED, LIST] });
    const same = await open(s.v2, { trigger: "trg_f", edit: true }, 60);
    await same.click(/^Save feed$/);
    expect(s.calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(same.went).toEqual(["#/triggers/trg_f"]);
    const t = await open(s.v2, { trigger: "trg_f", edit: true }, 60);
    await t.set("every", "30");
    await act(async () => { (t.host.querySelector('[aria-label="Remove condition 1"]') as HTMLButtonElement).click(); });
    await t.click(/^Save feed$/);
    expect(s.calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toEqual([{ source: { kind: "feed", urls: [STATUS, BLOG], every_s: 1800 } }]);
    const list = await open(s.v2, { trigger: "trg_l", edit: true }, 60);
    expect((list.host.querySelector("details[data-json-list]") as HTMLDetailsElement).open).toBe(true);
    expect(list.field("id")!.value).toBe("/number");
    await list.set("id", "/id");
    await list.click(/^Save feed$/);
    expect(s.calls.filter((c) => c.method === "PATCH").at(-1)!.body).toEqual({ source: { kind: "feed", urls: [PULLS], every_s: 300, items: "", id: "/id" } });
  });
});

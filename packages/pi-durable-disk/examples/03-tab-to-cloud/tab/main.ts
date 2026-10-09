// The page. Opening a run's link runs the agent in this tab when nothing else runs it: Wasmer boots the computer
// (bash, coreutils, node), the workspace comes back from the disk, and pi's Harness resumes over the pipe. The switcher
// moves the run between this tab and the server's other environments (a planned handover: the current host finishes
// its step and releases, the target claims, admits the agent's notice of the move and continues); the page shows how
// long the move took, from the click to the notice on screen. While the run is elsewhere the page watches it.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { watchEvents } from "@earendil-works/pi-durable";
import type { AgentEvent } from "@earendil-works/pi-durable";
import { ChatView, type ChatItem } from "./chat-view.ts";
import { PipeClient, type Attached, type Viewing } from "./pipe-client.ts";
import { finishStep, startTab, tabFacts, type TabRuntime } from "./runtime.ts";
import { WasmerEnv, wasmerWorkspaceFs } from "./wasmer-env.ts";
import { Workspace } from "./workspace.ts";
import { fromBase64, untag, type Environment, type FileEntry, type PipeFrame, type Placement, type Tagged } from "../wire.ts";

/** The largest workspace this page restores (a host's default is 1 GiB). */
const TAB_RESTORE_LIMIT_BYTES = 256 * 1024 * 1024;
const WASMER_SDK = "/wasmer/dist/index.js";
const COMPUTER = "/pkgs/edgejs.webc";

type ViewEvent = { kind: "snapshot"; event: AgentEvent } | { kind: "events"; events: AgentEvent[] };
type FileRow = { path: string; kind: "file" | "directory" | "symlink"; size: number; data?: string };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const match = /^\/run\/([A-Za-z0-9._-]+)$/.exec(location.pathname);
const run = match?.[1] ?? "";
const secret = location.hash.slice(1);
const tab = sessionStorage.getItem("tab-id") ?? `tab-${crypto.randomUUID().slice(0, 8)}`;
sessionStorage.setItem("tab-id", tab);

const state = {
  mode: "connecting" as "connecting" | "booting" | "writer" | "viewer" | "lost",
  placement: undefined as Placement | undefined,
  client: undefined as PipeClient | undefined,
  runtime: undefined as TabRuntime<WasmerEnv> | undefined,
  chat: new ChatView(),
  files: [] as FileRow[],
  selected: undefined as string | undefined,
  /** What a boot is doing now (shown under the badge). */
  progress: "",
  /** Why this tab stopped or what failed (shown as an alert until the next attach). */
  banner: "",
  generation: 0,
  /** Downloading and loading the computer, once per page. */
  computerMs: 0,
  /** From attached to the agent ready: sandbox, restore, Harness open and resume. */
  bootMs: 0,
  environments: [] as Environment[],
  /** The switch this page asked for, from the click until the agent's notice of it is on screen. */
  switching: undefined as { to: string; clickedAt: number; switchId?: string } | undefined,
  /** The switch this tab is draining for (it leaves the run). */
  leaving: undefined as string | undefined,
  /** Every switch this page asked for and saw complete. */
  handovers: [] as { switchId: string; to: string; ms: number }[],
  /** What the pipe acknowledged last when this tab left the run (`workspaceDigest`), and how its step ended. */
  left: undefined as { switchId: string; digest: string; step: string } | undefined,
};

const envLabel = (id: string | undefined) => state.environments.find((e) => e.id === id)?.label ?? id ?? "";

// ---- rendering ---------------------------------------------------------------------------------------------------------

function badge(): { text: string; tone: string; sub: string } {
  const p = state.placement;
  if (state.leaving) return { text: `Moving to ${p?.where === "moving" ? p.to : "the next host"}`, tone: "moving", sub: state.progress };
  if (state.mode === "booting") return { text: "Starting the computer in this tab", tone: "moving", sub: state.progress };
  if (state.mode === "writer") return { text: "Running in this tab", tone: "tab", sub: `brain + hands in this tab · disk claimed by the pipe, generation ${state.generation}` };
  if (state.mode === "connecting") return { text: "Connecting", tone: "moving", sub: "" };
  if (p?.where === "cloud") return { text: `Running in ${envLabel(p.env)}`, tone: "cloud", sub: `${p.host}${p.generation ? `, generation ${p.generation}` : ""}` };
  if (p?.where === "tab" && p.env !== "tab") return { text: `Running in ${envLabel(p.env)}`, tone: "cloud", sub: `through the pipe, generation ${p.generation}` };
  if (p?.where === "tab") return { text: "Running in another tab", tone: "other", sub: `generation ${p.generation} · read-only here` };
  if (p?.where === "moving") return { text: `Moving to ${p.to}`, tone: "moving", sub: p.detail ?? "" };
  return { text: "Parked on the disk", tone: "parked", sub: p?.detail ?? "" };
}

/** The environment the run is in (or moving to), for the switcher. */
function currentEnv(): { id: string | undefined; moving: boolean } {
  const p = state.placement;
  if (state.mode === "writer" && !state.leaving) return { id: "tab", moving: false };
  if (p?.where === "moving") return { id: p.env, moving: true };
  if (p?.where === "cloud") return { id: p.env, moving: false };
  if (p?.where === "tab" && p.env !== "tab") return { id: p.env, moving: false };
  return { id: undefined, moving: false };
}

function renderSwitcher(): void {
  const now = currentEnv();
  const busy = state.switching !== undefined || state.leaving !== undefined || now.moving || state.mode === "booting" || state.mode === "connecting";
  $("switcher").replaceChildren(
    ...state.environments.map((env) => {
      const active = env.id === now.id;
      const button = el("button", { class: `env ${env.kind}${active ? " active" : ""}${active && now.moving ? " moving" : ""}`, title: env.detail ?? "", "data-env": env.id }, env.label);
      (button as HTMLButtonElement).disabled = busy || active;
      button.addEventListener("click", () => switchTo(env.id));
      return button;
    }),
  );
  const last = state.handovers.at(-1);
  $("handover").textContent = last ? `moved to ${envLabel(last.to)} in ${(last.ms / 1000).toFixed(1)} s` : "";
}

/** Ask for a switch. Into this tab from another tab is a takeover; everything else is a planned switch. */
function switchTo(id: string): void {
  if (!state.client || state.switching) return;
  const p = state.placement;
  // Another browser tab runs it: take it over. A remote host gets a planned switch, as the cloud does.
  if (id === "tab" && ((p?.where === "tab" && p.env === "tab") || p?.where === "parked" || state.mode === "lost")) {
    void connect("write", p?.where === "tab");
    return;
  }
  state.switching = { to: id, clickedAt: performance.now() };
  state.client.send({ t: "switch", to: id });
  render();
}

/** The agent's notice of the switch this page asked for is on screen: the switch is done. */
function noticeSeen(): void {
  const s = state.switching;
  if (!s?.switchId) return;
  if (!state.chat.items().some((item) => item.kind === "switch" && item.switchId === s.switchId)) return;
  state.handovers.push({ switchId: s.switchId, to: s.to, ms: performance.now() - s.clickedAt });
  state.switching = undefined;
  renderSwitcher();
}

function el(tag: string, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const child of children) node.append(child);
  return node;
}

function renderChat(): void {
  const list = $("chat");
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  list.replaceChildren(...state.chat.items().map(renderItem));
  if (atBottom) list.scrollTop = list.scrollHeight;
  noticeSeen();
}

function renderItem(item: ChatItem): HTMLElement {
  switch (item.kind) {
    case "user":
      return el("div", { class: "msg user" }, el("div", { class: "who" }, "you"), el("div", { class: "body" }, item.text));
    case "assistant": {
      const body = el("div", { class: "body" }, item.text || (item.streaming ? "…" : ""));
      const node = el("div", { class: `msg agent${item.streaming ? " streaming" : ""}` }, el("div", { class: "who" }, "agent"));
      if (item.thinking) node.append(el("details", { class: "thinking" }, el("summary", {}, "thinking"), el("pre", {}, item.thinking)));
      node.append(body);
      return node;
    }
    case "tool": {
      let args = item.args;
      try {
        const parsed = JSON.parse(item.args) as Record<string, unknown>;
        args = typeof parsed.command === "string" ? `$ ${parsed.command}` : typeof parsed.path === "string" ? String(parsed.path) : item.args;
      } catch {
        // keep the raw text
      }
      return el(
        "div",
        { class: `tool ${item.status}` },
        el("div", { class: "tool-head" }, el("span", { class: "tool-name" }, item.name), el("span", { class: "tool-status" }, item.status)),
        el("pre", { class: "tool-args" }, args.slice(0, 2000)),
        ...(item.output ? [el("pre", { class: "tool-out" }, item.output.slice(-3000))] : []),
      );
    }
    case "note":
      return el("div", { class: "note" }, item.text);
    case "switch":
      return el("div", { class: `notice${item.planned ? "" : " unplanned"}` }, el("div", { class: "who" }, "system notice to the agent"), el("div", { class: "body" }, item.text));
  }
}

function renderFiles(): void {
  const files = state.files.filter((f) => !f.path.startsWith(".pi-tmp"));
  $("files").replaceChildren(
    ...(files.length === 0
      ? [el("div", { class: "empty" }, "No files yet.")]
      : files.map((f) => {
          const depth = f.path.split("/").length - 1;
          const row = el("button", { class: `file ${f.kind}${state.selected === f.path ? " selected" : ""}`, style: `padding-left:${12 + depth * 14}px` }, f.kind === "directory" ? `${f.path.split("/").pop()}/` : f.path.split("/").pop()!, el("span", { class: "size" }, f.kind === "file" ? fmtSize(f.size) : ""));
          row.addEventListener("click", () => void select(f.path));
          return row;
        })),
  );
}

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

async function select(path: string): Promise<void> {
  state.selected = path;
  renderFiles();
  const row = state.files.find((f) => f.path === path);
  let text = "";
  if (row?.kind === "file") {
    if (state.runtime) text = await state.runtime.env.sandbox.fs.readText(`/workspace/${path}`).catch((e: Error) => `(unreadable: ${e.message})`);
    else if (row.data !== undefined) text = new TextDecoder().decode(fromBase64(row.data));
  }
  $("preview-name").textContent = path;
  $("preview").textContent = text.slice(0, 20000);
}

function render(): void {
  const b = badge();
  const badgeEl = $("badge");
  badgeEl.className = `badge ${b.tone}`;
  $("badge-text").textContent = b.text;
  $("badge-sub").textContent = b.sub;
  $("banner").textContent = state.banner;
  $("banner").hidden = state.banner === "";
  const writer = state.mode === "writer" && !state.leaving;
  // Elsewhere, a message goes to whoever runs the run, through the server.
  const canSend = writer || (state.mode === "viewer" && (state.placement?.where === "cloud" || state.placement?.where === "tab"));
  ($("input") as HTMLTextAreaElement).disabled = !canSend;
  ($("send") as HTMLButtonElement).disabled = !canSend;
  $("composer").hidden = !canSend;
  // A fallback, not the switch: take the run from the cloud now, fencing it mid-step.
  $("takeover").hidden = !(state.mode === "viewer" && state.placement?.where === "cloud" && !state.switching);
  renderSwitcher();
  renderChat();
  renderFiles();
  renderStats();
}

function renderStats(): void {
  const c = state.client;
  if (!c || state.mode !== "writer") {
    $("stats").textContent = "";
    return;
  }
  const p50 = (xs: number[]) => (xs.length === 0 ? "-" : [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]!.toFixed(1));
  $("stats").textContent = `commits ${c.timings.commit.length} · p50 ${p50(c.timings.commit.map((t) => t.client))} ms · rtt ${p50(c.rtts)} ms · write-through p50 ${p50(c.timings.files.map((t) => t.client))} ms · computer ${(state.computerMs / 1000).toFixed(1)} s · attach ${Math.round(state.bootMs)} ms`;
}

// ---- the run here ------------------------------------------------------------------------------------------------------

type WasmerModule = typeof import("@wasmer/sdk");
let wasmer: InstanceType<WasmerModule["Wasmer"]> | undefined;
let computer: Awaited<ReturnType<NonNullable<typeof wasmer>["packages"]["load"]>> | undefined;

/** The computer's bytes, fetched ahead while this page only watches, so "Take over here" does not wait on the network. */
let prefetched: Promise<Uint8Array> | undefined;

async function fetchComputer(onProgress?: (got: number, total: number) => void): Promise<Uint8Array> {
  const response = await fetch(COMPUTER);
  const total = Number(response.headers.get("content-length") ?? 0);
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress?.(got, total);
  }
  const bytes = new Uint8Array(got);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

/** The SDK and the computer's package, once per page; a takeover or a reattach reuses them. */
let loading: Promise<NonNullable<typeof computer>> | undefined;

function ensureComputer(): Promise<NonNullable<typeof computer>> {
  loading ??= (async () => {
    const sdk = (await import(/* @vite-ignore */ WASMER_SDK)) as WasmerModule;
    wasmer ??= new sdk.Wasmer({ cache: { namespace: "tab-to-cloud" } });
    await wasmer.ready();
    const started = performance.now();
    state.progress = "downloading the computer (bash, coreutils, node)";
    render();
    const bytes = await (prefetched ?? fetchComputer((got, total) => ($("badge-sub").textContent = `downloading the computer: ${fmtSize(got)}${total ? ` of ${fmtSize(total)}` : ""}`)));
    state.progress = "loading the computer";
    render();
    computer = await wasmer.packages.load(bytes);
    state.computerMs = performance.now() - started;
    return computer;
  })();
  loading.catch(() => (loading = undefined));
  return loading;
}

async function runHere(attached: Attached, client: PipeClient): Promise<void> {
  state.mode = "booting";
  state.generation = attached.generation;
  state.progress = `restoring ${attached.files.filter((f) => f.kind === "file").length} files from the disk`;
  render();
  const started = performance.now();
  const pkg = await ensureComputer();
  const sandbox = await wasmer!.sandboxes.create({ packages: [pkg], shell: pkg.command("bash"), env: { LANG: "C.UTF-8" } });
  state.environments = attached.environments;
  const facts = tabFacts(pkg.commands, { cpus: navigator.hardwareConcurrency, ...((navigator as { deviceMemory?: number }).deviceMemory ? { memoryGb: (navigator as { deviceMemory?: number }).deviceMemory! } : {}) });
  const env = new WasmerEnv(sandbox as never, { id: `wasmer:${run}`, env: { HOME: "/workspace", LANG: "C.UTF-8", TERM: "dumb" } });
  const runtime = await startTab({ client, attached, env, workspace: new Workspace(wasmerWorkspaceFs(env)), ...(attached.move ? { move: { info: attached.move, facts } } : {}) });
  if (attached.move) client.send({ t: "switched", switchId: attached.move.id });
  state.runtime = runtime;
  state.bootMs = performance.now() - started;
  state.mode = "writer";
  state.progress = "";
  state.banner = "";
  state.chat = new ChatView();
  const stream = await watchEvents(runtime.harness, runtime.root.id, ctx);
  state.chat.apply(stream.snapshot);
  client.view({ kind: "snapshot", event: stream.snapshot } satisfies ViewEvent);
  stream.start(async (events) => {
    for (const event of events) state.chat.apply(event);
    client.view({ kind: "events", events: [...events] } satisfies ViewEvent);
    if (events.some((e) => e.type === "tool_execution_end" || e.type === "run_end")) await refreshFiles();
    renderChat();
    renderStats();
  });
  await refreshFiles();
  render();
  ($("input") as HTMLTextAreaElement).focus();
}

async function refreshFiles(): Promise<void> {
  if (!state.runtime) return;
  state.files = (await state.runtime.workspace.list()).map((f) => ({ path: f.path, kind: f.kind, size: f.size }));
  renderFiles();
  if (state.selected) void select(state.selected);
}

// ---- watching ----------------------------------------------------------------------------------------------------------

function applyView(event: Tagged): void {
  const view = untag(event) as ViewEvent;
  if (view.kind === "snapshot") {
    state.chat = new ChatView();
    state.chat.apply(view.event);
  } else for (const e of view.events) state.chat.apply(e);
}

function onFrame(frame: PipeFrame): void {
  switch (frame.t) {
    case "placement":
      state.placement = frame.placement;
      if (frame.placement.where === "tab" && frame.placement.tab === tab) state.generation = frame.placement.generation;
      if (frame.placement.where === "moving" && state.switching && !state.switching.switchId && frame.placement.switchId) state.switching.switchId = frame.placement.switchId;
      if (frame.placement.where === "parked") state.switching = undefined;
      break;
    case "drain":
      void drain(frame.switchId);
      return;
    case "run-here":
      void connect("write", false, frame.switchId);
      return;
    case "switch-refused":
      state.switching = undefined;
      state.banner = `cannot switch to ${envLabel(frame.to)}: ${frame.message}`;
      break;
    case "submit-refused":
      state.banner = `not sent: ${frame.message}`;
      break;
    case "event":
      applyView(frame.event);
      renderChat();
      return;
    case "files-changed":
      state.files = frame.files.map(fileRow);
      renderFiles();
      if (state.selected) void select(state.selected);
      return;
    case "want-snapshot":
      void sendSnapshot();
      return;
    case "submit":
      // A message a viewer typed: this tab runs the run.
      if (state.runtime && state.mode === "writer") void state.runtime.root.submit({ type: "input", content: frame.text, requestId: frame.requestId }, ctx).catch(() => undefined);
      return;
    default:
      return;
  }
  render();
}

/** The pipe asks this tab to leave the run: finish the step in progress, close the agent here, say so. */
async function drain(switchId: string): Promise<void> {
  state.leaving = switchId;
  state.progress = "finishing the current step";
  render();
  const runtime = state.runtime;
  if (runtime) {
    const how = await finishStep(runtime.harness, 8_000).catch(() => "timeout" as const);
    // Every write-through is acknowledged before its tool result commits: what the disk has from this tab.
    state.left = { switchId, digest: await runtime.workspace.baselineDigest(), step: how };
    state.progress = how === "idle" ? "the agent was idle; handing over" : how === "step" ? "step finished; handing over" : "step still running; handing over (the next host resumes it)";
    render();
    state.runtime = undefined;
    await runtime.close().catch(() => undefined);
  }
  state.client?.send({ t: "drained", switchId });
}

/** A fresh snapshot of this tab's conversation for the viewers (a viewer just joined). */
async function sendSnapshot(): Promise<void> {
  const runtime = state.runtime;
  if (!runtime || state.mode !== "writer") return;
  const stream = await watchEvents(runtime.harness, runtime.root.id, ctx);
  state.client?.view({ kind: "snapshot", event: stream.snapshot } satisfies ViewEvent);
  await stream.stop();
}

const fileRow = (f: FileEntry): FileRow => (f.kind === "file" ? { path: f.path, kind: "file", size: Math.floor((f.data.length * 3) / 4), data: f.data } : { path: f.path, kind: f.kind, size: 0 });

/** Opening the link runs the agent here once, when nothing runs it; a run held elsewhere is only watched. */
let offeredToRun = false;

function watching(viewing: Viewing): void {
  state.mode = "viewer";
  state.progress = "";
  state.leaving = undefined;
  state.environments = viewing.environments;
  state.placement = viewing.placement;
  state.files = viewing.files.map(fileRow);
  state.chat = new ChatView();
  for (const event of viewing.events) applyView(event);
  render();
  if (viewing.placement.where === "parked" && !offeredToRun) {
    offeredToRun = true;
    void connect("write");
  } else if (!computer && !prefetched) {
    // A page that only watches gets its computer ready in the background, so "Take over here" only has to attach.
    prefetched = fetchComputer();
    prefetched.then(() => ensureComputer()).catch(() => (prefetched = undefined));
  }
}

// ---- connection --------------------------------------------------------------------------------------------------------

async function connect(mode: "write" | "view", takeover = false, switchId?: string): Promise<void> {
  state.client?.close();
  state.client = undefined;
  if (mode === "write") {
    // The computer boots before the tab asks for the run: the pipe holds a claim only for a tab that can use it.
    state.mode = "booting";
    render();
    await ensureComputer();
  }
  state.mode = "connecting";
  render();
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const client = new PipeClient({
    url: `${proto}//${location.host}/ws`,
    run,
    token: secret,
    tab,
    // While it watches, this page is its user's control: it may switch the run and send it messages, and run it here.
    mode: mode === "write" ? "write" : "operator",
    canRun: true,
    takeover,
    ...(switchId ? { switchId } : {}),
    onFrame,
    onLost: (code, message) => void lost(client, code, message),
    // The page holds the whole restored workspace in memory, then in the sandbox: a smaller bound than a host's.
    restoreLimitBytes: TAB_RESTORE_LIMIT_BYTES,
  });
  state.client = client;
  try {
    const first = await client.ready;
    if (first.t === "attached") await runHere(first, client);
    else watching(first);
  } catch (error) {
    if (state.client === client && (state.mode as string) !== "lost") {
      state.mode = "lost";
      state.banner = `could not attach: ${(error as Error).message}`;
      render();
    }
  }
}

async function lost(client: PipeClient, code: string, message: string): Promise<void> {
  if (state.client !== client) return;
  const wasWriter = state.mode === "writer" || state.mode === "booting";
  await state.runtime?.close().catch(() => undefined);
  state.runtime = undefined;
  if (state.leaving && code === "RELEASED") {
    // This tab handed the run over: watch where it went.
    state.mode = "connecting";
    render();
    void connect("view");
    return;
  }
  state.mode = "lost";
  state.banner =
    code === "MOVED" ? "This run moved to another device. This tab stopped; it wrote nothing after the move." :
    code === "FENCED" ? "Another host took the run's disk. This tab stopped; its writes after that were refused." :
    code === "RELEASED" ? "The run was handed to the cloud." :
    code === "CLOSED" ? "The connection to the disk closed." : message;
  render();
  // Keep watching from here, read-only.
  if (wasWriter || code !== "CLOSED") setTimeout(() => void connect("view"), 800);
}

function send(): void {
  const input = $("input") as HTMLTextAreaElement;
  const text = input.value.trim();
  if (!text) return;
  if (!state.runtime) {
    if (state.mode !== "viewer" || (state.placement?.where !== "cloud" && state.placement?.where !== "tab")) return;
    input.value = "";
    state.client?.send({ t: "submit", text, requestId: `ui-${crypto.randomUUID()}` });
    return;
  }
  input.value = "";
  void state.runtime.root.submit({ type: "input", content: text, requestId: `ui-${crypto.randomUUID()}` }, ctx).catch((error: Error) => {
    state.banner = `not sent: ${error.message}`;
    render();
  });
}

$("send").addEventListener("click", send);
$("input").addEventListener("keydown", (e) => {
  if ((e as KeyboardEvent).key === "Enter" && !(e as KeyboardEvent).shiftKey) {
    e.preventDefault();
    send();
  }
});
$("takeover").addEventListener("click", () => void connect("write", true));
setInterval(renderStats, 1000);

if (!run || !secret) {
  $("badge-text").textContent = "No run";
  $("badge-sub").textContent = "Open a run's link: /run/<id>#<secret>";
} else void connect("view");

// For the recording script: what the page shows, in one object.
(globalThis as { demo?: unknown }).demo = {
  state,
  items: () => state.chat.items(),
  files: () => state.files.map((f) => f.path),
  /** What the pipe acknowledged last, as `workspaceDigest`; null when this tab does not run the agent. */
  ackedDigest: () => state.runtime?.workspace.baselineDigest() ?? null,
  acks: () => state.client?.timings.files.length ?? 0,
  /** The root conversation's entries from the store, oldest first: kind, and the tool call ids each one names. */
  entries: async () => {
    if (!state.runtime) return null;
    const page = await state.runtime.root.entries({}, 500, undefined, ctx);
    return [...page.items].reverse().map((e) => {
      const m = ((e as unknown as { model?: { role: string; content?: unknown; toolCallId?: string; isError?: boolean }[] }).model ?? [])[0];
      const calls = Array.isArray(m?.content) ? (m.content as { type: string; id?: string }[]).filter((c) => c.type === "toolCall").map((c) => c.id) : [];
      return { id: String(e.id), kind: e.kind, calls, result: m?.toolCallId, isError: m?.isError };
    });
  },
  handovers: () => state.handovers,
  left: () => state.left,
  switchTo,
  timings: () => state.client && { commit: state.client.timings.commit, files: state.client.timings.files, rtts: state.client.rtts, computerMs: state.computerMs, bootMs: state.bootMs, syncs: state.runtime?.syncs },
};

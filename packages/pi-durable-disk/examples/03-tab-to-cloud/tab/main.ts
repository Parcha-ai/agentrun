// The page. Opening a run's link runs the agent in this tab when nothing else runs it: Wasmer boots the computer
// (bash, coreutils, node), the workspace comes back from the disk, and pi's Harness resumes over the pipe. The switcher
// moves the run between this tab and the server's other environments (a planned handover: the current host finishes
// its step and releases, the target claims, admits the agent's notice of the move and continues); the page shows how
// long the move took, from the click to the notice on screen. While the run is elsewhere the page watches it.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { watchEvents } from "@earendil-works/pi-durable";
import type { AgentEvent, AgentEventStream, Conversation, EntryRecord } from "@earendil-works/pi-durable";
import { Brain, findSwap, judgeFor, readManifest } from "./brain.ts";
import { BRAIN_PROVIDER, brainModel, brainProvider, DEFAULT_TOOL_DECODING } from "./brain-provider.ts";
import { ChatView, type ChatItem } from "./chat-view.ts";
import { parseMarkdown, type Inline } from "./markdown.ts";
import { callsLabel, driverLabel, echoedTools, fallbackLine, isMuted, moveLine, movesAfterTheirMessage, pendingEchoes, placementLine, relayedModel, sentBase, sentState, toolArgsLine, withoutSent, type Sent } from "./chat-lines.ts";
import { fileElement, mountTree, type TreeHandle } from "./code-view.ts";
import { hasBody, resultCardElement, toolBody } from "./tool-body.ts";
import { briefsFromArgs, teachResultCard } from "./teach-result.ts";
import { WriteMemory } from "./write-memory.ts";
import { fitPlaceholder } from "./hint.ts";
import { Latest } from "./latest.ts";
import { ACTIVE, ThreadSet, threadsByCall, type Thread, type ThreadMsg } from "./threads.ts";
import { verdictOf } from "../../04-walks-home/tab/src/guard.ts";
import { wllamaLlm } from "../../04-walks-home/tab/src/llm.ts";
import { isBaseAdapters } from "../../04-walks-home/tab/src/adapter-manifest.ts";
import { comeHome, describeHome, opfsFileStore } from "../../04-walks-home/tab/src/homecoming.ts";
import { composerRoute, submitFrameKind } from "./composer.ts";
import { stageFiles } from "./offline-cache.ts";
import { PipeClient, type Attached, type Viewing } from "./pipe-client.ts";
import { finishStep, startLocal, untilIdle, startTab, tabFacts, type TabRuntime } from "./runtime.ts";
import { deleteStore, exportStore, importStore, openLocalStore, type LocalStore } from "./local-store.ts";
import { applyChanges, forgetWorkspace, loadBaseline, loadWorkspace, saveBaseline, saveWorkspace } from "./workspace-store.ts";
import { baselineOf, CheckinError, diffWorkspace, postCheckin, type Snapshot } from "./checkin.ts";
import { scriptedCloud, type ScriptedTurn, type SeenRequest } from "./scripted-cloud.ts";
import { BRAIN_CHECKIN, BRAIN_DECISION } from "./brain-kinds.ts";
import { brainEvent, brainRouter, type JudgeRunner } from "../brain-router.ts";
import { callGrammar, renderPrompt, TOOLS } from "./tool-format.ts";
import { CANNOT_OFFLINE, cacheRunForOffline, CheckoutError, confirmHandover, fetchStoreCopy, forgetCheckinPayload, forgetCheckout, loadCheckinPayload, readCheckout, saveCheckinPayload, registerOfflineWorker, requestCheckout, writeCheckout, type CheckoutRecord, cacheFilesForOffline } from "./offline.ts";
import type { ModelHost, ToolChatMessage, ToolChatTool } from "../../04-walks-home/tab/src/modelhost.ts";
import { stateLine } from "../robot-state-line.ts";
import { WasmerEnv, wasmerWorkspaceFs } from "./wasmer-env.ts";
import { Workspace } from "./workspace.ts";
import { FilesEnv, memoryFs } from "./files-env.ts";
import { workspaceText } from "./file-text.ts";
import { narrowEnum, servingView, signatureTools, signatureView, toNativeTools } from "./native-turn.ts";
import { PhoneModel, served } from "./phone-model.ts";
import { startV5Brain, V5_MODEL_ID, v5SmallFiles, v5Urls, type V5Brain } from "./v5-brain.ts";
import { wllamaLlm as wllamaForPrefetch } from "../../04-walks-home/tab/src/llm.ts";
import { FrameSwitchChannel } from "../switch-tool.ts";
import { OfflineRefusedError, type OfflineChannel } from "../offline-tools.ts";
import { cloudAgent, rootAgent, setExtraInstructions, tabPlace, type AppPolicy } from "../agent.ts";
import { ROBOT_SOPS } from "./robot-sop.ts";
import { parseSkills, skillPolicyPath } from "../../04-walks-home/tab/src/skills.ts";
import { WriteGate } from "./write-gate.ts";
import { SubmitGate, type GatePhase } from "./submit-gate.ts";
import { withHomeFallback } from "./home-env.ts";
import { currentRobot, defaultSkill, loadSkills, ROBOT_TOOLS } from "../robot-tools.ts";
import { ROBOT_SYSTEM } from "../robot-model.ts";
import { creatureActivity } from "./creature-activity.ts";
import { tag, untag, type Environment, type FileChange, type FileEntry, type PipeFrame, type Placement, type Tagged } from "../wire.ts";

/** The largest workspace this page restores (a host's default is 1 GiB). */
const TAB_RESTORE_LIMIT_BYTES = 256 * 1024 * 1024;
const WASMER_SDK = "/wasmer/dist/index.js";
const COMPUTER = "/pkgs/edgejs.webc";

/** `root: false` marks the events of a conversation that is not the run's root (the local brain's): the server reads the root's model from the rest. */
type ViewEvent = ({ kind: "snapshot"; event: AgentEvent } | { kind: "events"; events: AgentEvent[] } | { kind: "models"; names: Record<string, string> }) & { root?: false };
type FileRow = { path: string; kind: "file" | "directory" | "symlink"; size: number; data?: string };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const match = /^\/run\/([A-Za-z0-9._-]+)$/.exec(location.pathname);
/** `?phone=1`: pi itself on a phone, offline from the start (startPhone): this browser's store, the robot's tools on a page with no computer, a small model in the page. */
const phoneMode = new URLSearchParams(location.search).get("phone") === "1";
/** The laptop's offline brain is v5 (v5-brain.ts), the same one the phone runs: with the robot pane (?robot=1), unless ?brain=off, ?template=native (the MiniCPM spike) or ?v5=0. */
const v5Offline = (() => { const q = new URLSearchParams(location.search); return q.get("robot") === "1" && !phoneMode && q.get("brain") !== "off" && q.get("template") !== "native" && q.get("v5") !== "0"; })();
const run = match?.[1] ?? (phoneMode ? "phone" : "");
const secret = location.hash.slice(1);
const tab = sessionStorage.getItem("tab-id") ?? `tab-${crypto.randomUUID().slice(0, 8)}`;
sessionStorage.setItem("tab-id", tab);

/**
 * `?golive=1`: the agent takes its run offline and brings it back with its own tools (offline-tools.ts), the page's button doing the same for a check. The trained model does not take over
 * when it is home: it takes over when the agent goes offline, in the SAME conversation (brain.ts configure), with the tools read, write and bash; going online hands the work back and the
 * conversation is configured onto the cloud model again.
 */
const golive = new URLSearchParams(location.search).get("golive") === "1";
/** Code mode (default): the run starts with a robot that is code and the agent is not offered the preset tools; ?robotcode=0 is the preset flow (the checks of those tools). */
const robotCodeOn = new URLSearchParams(location.search).get("robotcode") !== "0";

/** What the page tells the stage when a run comes home (and a check reads): the head the server now holds, the files written offline, how long it took. */
export type CheckinEvent = { at: number; head: number; files: number; changes: number; ms: number; offlineHead: number };

const state = {
  /** Whether this page can reach the server: the browser's own signal and a ping (`pingNet`). */
  net: { online: navigator.onLine, at: Date.now(), reason: navigator.onLine ? "" : "the browser says it is offline" },
  /** "Go online" in progress, in words (shown next to the button). */
  checkingIn: undefined as { text: string } | undefined,
  /** The trained model is being replaced by a newer one (watchRehome): messages wait, the model answers nothing meanwhile. */
  rehoming: false,
  /** A check-in whose answer never came: kept (and the page paused) until it is sent again. */
  pendingCheckin: undefined as { record: CheckoutRecord; host: ModelHost | undefined } | undefined,
  /** Every check-in this page made and saw complete. */
  checkins: [] as CheckinEvent[],
  /** A scripted stand-in for the cloud model (a check's, installed by `demo.stubCloud`), and what its requests carried. */
  /** What the manifest watcher last saw (for checks): polls, the id it read, why it could not read. */
  watch: { polls: 0, seen: null as string | null, error: null as string | null },
  /** Every routing decision this page made (brain-router.ts), as the stage event for the decision card. */
  decisions: [] as ReturnType<typeof brainEvent>[],
  cloudScript: undefined as ScriptedTurn[] | undefined,
  cloudSeen: [] as SeenRequest[],
  mode: "connecting" as "connecting" | "booting" | "writer" | "viewer" | "lost" | "offline",
  placement: undefined as Placement | undefined,
  client: undefined as PipeClient | undefined,
  /** The attach said the server places this run: the composer's lines go through it (composer.ts). */
  placed: false,
  runtime: undefined as TabRuntime | undefined,
  chat: new ChatView(),
  /** The lines this page sent that the transcript does not hold yet: shown at once, with where they are (chat-lines.ts `pendingEchoes`). */
  sent: [] as Sent[],
  /** The conversation the chat input goes to: the root until the trained model comes home, then the fresh one on it (brain.ts). */
  active: undefined as Conversation | undefined,
  /** The run is checked out to this browser and this page runs it from OPFS (offline.ts, local-store.ts): its record and its store. */
  offline: undefined as { record: CheckoutRecord; store: LocalStore; computer: { booted: boolean; ms: number; files: number; error?: string; parts?: Record<string, number> } } | undefined,
  /** "Take it offline" in progress, in words (shown next to the button). */
  checkout: undefined as { text: string } | undefined,
  /** From the click on: this tab's input is held and a viewer's message is not acted on. */
  checkingOut: false,
  /** The handover has been asked of the pipe: the pipe closing this tab's socket is then the handover itself, not a loss. Before that it is an ordinary loss. */
  handoverAsked: false,
  /** A loss of the pipe that came while the checkout was still preparing (caching, copying): kept, and replayed if the checkout does not go through. */
  savedLoss: undefined as { client: PipeClient; code: string; message: string } | undefined,
  /** The cloud model's id on this run (from the attach), kept for the root conversation of the offline copy. */
  agentModel: "",
  /** What the host told the page about its agent (the attach's `app`): its instructions and the extensions to leave out, kept for every agent change the page makes (a check-in puts the cloud model back). */
  app: undefined as AppPolicy | undefined,
  /** The model the relayed events say the agent is on (the snapshot's agent, each agent_changed), for a page that only watches: the session may be on a host this page has no runtime of. */
  relayedModel: null as { provider: string; modelId: string } | null,
  /** The names the host registered its models with, by `provider/modelId`, as the pipe relays them. */
  modelNames: {} as Record<string, string>,
  /** `?thinking=open`: thinking blocks are open and dimmed as they stream instead of folded. */
  thinkingOpen: new URLSearchParams(location.search).get("thinking") === "open",
  /** What each tool turn of the trained model cost and produced (?configure=1), for checks and the page's stats. */
  /** Each homecoming of a base and adapters: what was planned, the bytes fetched and how long it took (`model-homecoming`, and the base's prefetch). */
  homecomings: [] as Record<string, unknown>[],
  toolTurns: [] as { ms: number; tokensPerSecond: number | null; promptTokens: number; outputTokens: number; thinkTokens: number; calls: number; thinkingCut: boolean; cut: boolean; call: string | null; problem: string | null; raw: string; completions: unknown[]; prompt: string }[],
  /** The trained model's host for this run, once the page has started on it. */
  brain: undefined as Brain | undefined,
  /** A swap from an earlier visit is on this run: the saved conversation is on its way back, and until it is ready a message would go to the cloud conversation instead. Input waits. */
  brainPending: false,
  /** What the brain swap is doing now, in words (shown under the badge). */
  brainStatus: "",
  /** A model is being brought home or loaded right now (a status line alone does not say so). */
  brainLoading: false,
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
  /** ?phone=1: what the phone's brain is doing, and what it cost. */
  phone: undefined as { phase: string; ready: boolean; model?: PhoneModel; marks: Record<string, number>; log: string[]; turnStarted?: number } | undefined,
  /** The laptop's offline brain (v5, v5-brain.ts): kept in this browser while online, loaded when the run is taken offline. */
  v5: { prefetch: "idle" as "idle" | "running" | "done" | "failed" | "unavailable", prefetchText: "", ready: false, brain: undefined as V5Brain | undefined, marks: {} as Record<string, number>, log: [] as string[] },
};

/** The host's app policy for an agent change (see `state.app`): none when it gave none. */
const appOption = (): { app?: AppPolicy } => (state.app ? { app: state.app } : {});
/** This page's own environment as the server names it ("your user's browser tab"), from the last attach: the agent's model line says it runs here. */
let herePlace: string | undefined;
const placed = () => (herePlace ? { place: herePlace } : {});
const envLabel = (id: string | undefined) => state.environments.find((e) => e.id === id)?.label ?? id ?? "";

// ---- rendering ---------------------------------------------------------------------------------------------------------

/** Where the agent runs, as the bar names it: this tab is "browser (Wasm)" (the computer in it is Wasmer), a remote host by its own label. */
const whereName = (id: string | undefined) => (id === "tab" || state.environments.find((e) => e.id === id)?.kind === "tab" ? "browser (Wasm)" : envLabel(id));

/** The bar's "Running in: <text>": the place, or a quiet 'moving to ...'. The facts that used to sit under it (host, generation, progress) are its tooltip. */
function badge(): { text: string; tone: string; sub: string } {
  const p = state.placement;
  if (phoneMode) return { text: "browser (Wasm)", tone: "offline", sub: state.phone?.phase ?? state.progress };
  if (state.mode === "offline") return { text: "browser (Wasm)", tone: "offline", sub: "checked out to this browser: the only live copy of this run is here, the server no longer runs it" };
  if (state.leaving) return { text: `moving to ${p?.where === "moving" ? whereName(p.to) : "the next host"}`, tone: "moving", sub: state.progress };
  if (state.mode === "booting") return { text: "browser (Wasm)", tone: "moving", sub: state.progress };
  if (state.mode === "writer") return { text: "browser (Wasm)", tone: "tab", sub: `brain + hands in this tab · disk claimed by the pipe, generation ${state.generation}` };
  if (state.mode === "connecting") return { text: "connecting", tone: "moving", sub: "" };
  if (p?.where === "cloud") return { text: whereName(p.env), tone: "cloud", sub: `${p.host}${p.generation ? `, generation ${p.generation}` : ""}` };
  if (p?.where === "tab" && p.env !== "tab") return { text: whereName(p.env), tone: "cloud", sub: `through the pipe, generation ${p.generation}` };
  if (p?.where === "tab") return { text: "another tab", tone: "other", sub: `generation ${p.generation} · read-only here` };
  if (p?.where === "moving") return { text: `moving to ${whereName(p.to)}`, tone: "moving", sub: p.detail ?? "" };
  if (p?.where === "checked-out") return { text: "another browser", tone: "parked", sub: "its live copy is in that browser; nothing here runs it any more" };
  return { text: "nowhere (parked)", tone: "parked", sub: p?.detail ?? "" };
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
  const busy = state.switching !== undefined || state.leaving !== undefined || now.moving || state.mode === "booting" || state.mode === "connecting" || state.placement?.where === "checked-out";
  $("switcher").replaceChildren(
    ...state.environments.map((env) => {
      const active = env.id === now.id;
      const button = el("button", { class: `env ${env.kind}${active ? " active" : ""}${active && now.moving ? " moving" : ""}`, title: env.detail ?? "", "data-env": env.id }, env.label);
      (button as HTMLButtonElement).disabled = busy || active;
      button.addEventListener("click", () => switchTo(env.id));
      return button;
    }),
  );
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

/** The tool rows of the current task (after the last user message) as last announced: only a change is announced again. */
let lastTools = "";

/**
 * The tool strip for a stage that cannot read the transcript (offline the pipe is cut): every change of the current task's tool rows is announced as `walkshome:tools`
 * {tools: [{id, name, args (the JSON string), output (cut at 4000 characters), status: running | done | error | interrupted}]}.
 */
function announceTools(items: readonly ChatItem[]): void {
  const lastUser = items.map((i) => i.kind).lastIndexOf("user");
  const tools = items.slice(lastUser + 1).filter((i): i is Extract<ChatItem, { kind: "tool" }> => i.kind === "tool").map((t) => ({ id: t.id, name: t.name, args: t.args, output: t.output.length > 4000 ? `${t.output.slice(0, 4000)}…` : t.output, status: t.status }));
  const json = JSON.stringify(tools);
  if (json === lastTools) return;
  lastTools = json;
  announce("tools", { tools });
}

/** The teaching threads (child conversations on their own GPUs): relayed to this page by the host that runs the agent (thread-relay.ts), drawn inside the teach_skills call. */
const teachThreads = new ThreadSet();
/** The threads of each teach_skills call, by the call's id (a second call is a second run, with its own threads); worked out at each redraw. */
let callThreads = new Map<string, Thread[]>();

/** The tool results the reader has open, by the call's id: the chat is redrawn on every agent event, and a result being read must not close under them. */
const openTools = new Set<string>();
/** The teach_skills calls that were opened for the reader once already. */
const autoOpened = new Set<string>();

/** The composer's hint, on one line: cut to the field's width with an ellipsis (a textarea's placeholder cannot do that itself), the whole text kept as the field's title, and fitted again when the width changes. */
let hintText = "";
const hintCanvas = typeof document === "undefined" ? undefined : document.createElement("canvas").getContext("2d");
function fitHint(): void {
  if (hintText === "") return; // no hint set: the field keeps the placeholder its HTML gave it
  const input = $("input") as HTMLTextAreaElement;
  const cs = getComputedStyle(input);
  const width = input.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  if (hintCanvas) hintCanvas.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  input.placeholder = fitPlaceholder(input.placeholder, hintText, hintCanvas ? width : 0, (t) => hintCanvas?.measureText(t).width ?? 0);
  input.title = hintText;
}
function setHint(text: string): void {
  hintText = text;
  fitHint();
}
addEventListener("resize", () => fitHint());

/**
 * The chat follows the newest line while the reader is at the bottom, and leaves them alone once they scroll up. "At the bottom" is the reader's last scroll, not a measure taken at each redraw: a diff is drawn
 * after the redraw that made room for it, so the page keeps growing for a moment, and the follow must hold through that (a resize of any line re-pins it).
 */
let following = true;
const chatSizes = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => { if (following) { const c = $("chat"); c.scrollTop = c.scrollHeight; } });
// Only the reader turns the follow off (a scroll up by wheel, finger or the scrollbar); our own pin never does, even when the page has grown again before its scroll event arrives. Reaching the bottom turns it on.
let readerScrolling = false;
$("chat").addEventListener("wheel", (e) => { if (e.deltaY < 0) following = false; }, { passive: true });
$("chat").addEventListener("pointerdown", () => { readerScrolling = true; });
$("chat").addEventListener("touchstart", () => { readerScrolling = true; }, { passive: true });
addEventListener("pointerup", () => { readerScrolling = false; });
addEventListener("touchend", () => { readerScrolling = false; });
$("chat").addEventListener("scroll", () => {
  const c = $("chat");
  if (c.scrollHeight - c.scrollTop - c.clientHeight < 80) following = true;
  else if (readerScrolling) following = false;
});

function renderChat(): void {
  const list = $("chat");
  const held = state.chat.items();
  announceTools(held);
  const items = movesAfterTheirMessage(held);
  const echoed = echoedTools(items);
  state.sent = pendingEchoes(held, state.sent); // a line the transcript holds now is its own; an echo is only for the gap before
  callThreads = threadsByCall(items.filter((i) => i.kind === "tool" && i.name === "teach_skills").map((i) => i.id), teachThreads.list());
  chatSizes?.disconnect();
  list.replaceChildren(...items.filter((item) => !(item.kind === "brain" && (item.stage === "moved" || item.stage === "decision"))).map((item) => renderItem(item, echoed)), ...state.sent.flatMap((s) => [el("div", { class: "turn user sent" }, s.text), ...(sentState(s) ? [el("div", { class: "move sent-state" }, sentState(s))] : [])]));
  if (following) list.scrollTop = list.scrollHeight;
  for (const child of list.children) chatSizes?.observe(child);
  noticeSeen();
}

/** The body of each tool call as last drawn, by call id: redrawing the chat on every agent event reuses it unless the call changed (a diff is not drawn again for nothing). */
const bodies = new Map<string, { signature: string; body: HTMLElement | null }>();
/** The commands whose whole output the reader asked for (the rest show their last lines). */
const fullOutput = new Set<string>();
/** The commands whose raw output the reader chose over the trainer's quiet lines. */
const rawOutput = new Set<string>();
/** A file's text as it was just before a write replaced it, by the write's call id (the diff is against this; a write to a new file has none). */
const writeBefore = new Map<string, string>();

/** The teaching threads inside the teach_skills call: one row per thread (its GPU, its name, where it is), each opening to that thread's own tool calls, drawn with the same lines and bodies as the root's. */
function threadsBody(item: Extract<ChatItem, { kind: "tool" }>, threads: readonly Thread[], showOutput: boolean): HTMLElement {
  const wrap = el("div", { class: "tool-body threads" });
  const briefs = briefsFromArgs(item.args);
  for (const t of threads) {
    const key = `thread:${t.conversation}`;
    const items = t.chat.items();
    // The thread's conversation was forked from the agent's, so it begins with what the agent had; the thread's own work starts at its prompt (its last user message), which is the model's: the reader sees
    // the brief the parent gave it (teach_skills' own arguments, by the thread's name), as one quiet line.
    const from = Math.max(0, items.map((i) => i.kind).lastIndexOf("user"));
    const mine = items.slice(from).filter((i) => i.kind !== "user");
    const brief = briefs.get(t.name);
    const echoed = echoedTools(mine);
    const dot = ACTIVE.has(t.status) ? "dot act run" : t.status === "passed" || t.status === "reported" ? "dot done" : "dot";
    const summary = el("summary", {}, el("span", { class: dot }), el("span", { class: "gpu" }, t.gpu === null ? "GPU" : `GPU ${t.gpu}`), el("span", { class: "name" }, t.name), el("span", { class: "args" }, ACTIVE.has(t.status) ? `${t.status === "queued" ? "waiting for a GPU, " : ""}${callsLabel(mine.filter((i) => i.kind === "tool").length)}` : t.status));
    // Every thread opens by itself once, so a viewer sees them all working; the reader can close one, and it stays closed.
    if (!autoOpened.has(key)) {
      autoOpened.add(key);
      openTools.add(key);
    }
    const row = el("details", { class: `thread ${t.status}` }, summary) as HTMLDetailsElement;
    const draw = () => row.append(el("div", { class: "thread-chat" }, ...(brief ? [el("div", { class: "brief" }, brief)] : []), ...mine.map((i) => renderItem(i, echoed, `t${t.conversation}:`))));
    if (openTools.has(key)) draw();
    row.open = openTools.has(key);
    row.addEventListener("toggle", () => {
      if (row.open) {
        openTools.add(key);
        if (!row.querySelector(".thread-chat")) draw();
      } else openTools.delete(key);
    });
    wrap.append(row);
  }
  const card = teachResultCard(item.details);
  if (card) wrap.append(resultCardElement(card)); // the result for the reader: its text is for the model
  else if (showOutput && item.output) wrap.append(el("pre", { class: "out" }, item.output.slice(-3000)));
  return wrap;
}

/** An assistant's words as elements, from the safe markdown subset (tab/markdown.ts): built with textContent, so nothing the model wrote is parsed as HTML. */
function markdownNodes(text: string): Node[] {
  const spans = (list: readonly Inline[]): Node[] =>
    list.map((x) => (x.t === "text" ? document.createTextNode(x.v) : x.t === "br" ? el("br") : x.t === "code" ? el("code", {}, x.v) : el(x.t === "b" ? "strong" : "em", {}, ...spans(x.c))));
  return parseMarkdown(text).map((b) => (b.t === "p" ? el("p", {}, ...spans(b.c)) : b.t === "pre" ? el("pre", { class: "md-pre" }, b.v) : el(b.t, {}, ...b.items.map((i) => el("li", {}, ...spans(i))))));
}

function renderItem(item: ChatItem, echoed: ReadonlySet<string> = new Set(), scope = ""): HTMLElement {
  switch (item.kind) {
    case "user":
      return el("div", { class: "turn user" }, item.text);
    case "assistant": {
      const node = el("div", { class: `turn agent${item.streaming ? " streaming" : ""}` });
      // `?thinking=open`: the thinking is on the page as it streams (dimmed, not folded away); otherwise it is one line that opens on tap.
      if (item.thinking) node.append(state.thinkingOpen ? el("div", { class: "thinking open" }, el("div", { class: "label" }, "thinking"), el("pre", {}, item.thinking)) : el("details", { class: "thinking" }, el("summary", {}, "thinking"), el("pre", {}, item.thinking)));
      if (item.text) node.append(...markdownNodes(item.text));
      else if (item.streaming) node.append("…");
      if (item.fallback) node.append(el("div", { class: "note fallback" }, fallbackLine(item.fallback)));
      return node;
    }
    case "tool": {
      // One quiet line: ● name  what it was given. It opens on tap: bash its command and output, write and edit the diff, grep its hits, anything else its result (unless the reply that follows says it word for word).
      // The body (a diff especially) is built when the row is first opened, and again only when what it shows changed.
      const key = scope + item.id;
      const dot = item.status === "running" ? "dot act run" : item.status === "done" && !isMuted(item) ? "dot done" : "dot";
      const summary = el("summary", {}, el("span", { class: dot }), el("span", { class: "name" }, item.name), el("span", { class: "args" }, toolArgsLine(item.name, item.args)), ...(item.status === "error" ? [el("span", { class: "state" }, item.diagnostics?.find((d) => d.severity === "error")?.message ?? "failed")] : []));
      const showOutput = !echoed.has(item.id);
      const mine = scope === "" && item.name === "teach_skills" ? callThreads.get(item.id) ?? [] : [];
      const teach = mine.length > 0;
      // The teaching call opens by itself the first time it has threads (they are the point of it); the reader can close it, and it stays closed.
      if (teach && !autoOpened.has(key)) {
        autoOpened.add(key);
        openTools.add(key);
      }
      const has = teach || hasBody(item, { showOutput });
      const node = el("details", { class: `tool ${item.status}${isMuted(item) ? " refused" : ""}${has ? "" : " bare"}` }, summary) as HTMLDetailsElement;
      const fill = () => {
        const before = writeBefore.get(key);
        const signature = JSON.stringify([item.name, item.args, item.status, item.output, showOutput, before ?? null, teach ? teachThreads.version : 0]);
        const cached = bodies.get(key);
        const body = cached && cached.signature === signature ? cached.body : teach ? threadsBody(item, mine, showOutput) : toolBody(item, { showOutput, before, expanded: fullOutput.has(key), onToggle: (all) => (all ? fullOutput.add(key) : fullOutput.delete(key)), raw: rawOutput.has(key), onRaw: (raw) => (raw ? rawOutput.add(key) : rawOutput.delete(key)) });
        if (!cached || cached.signature !== signature) bodies.set(key, { signature, body });
        if (body !== null && body.parentElement !== node) node.append(body);
      };
      if (has && openTools.has(key)) fill();
      node.open = has && openTools.has(key);
      node.addEventListener("toggle", () => {
        if (node.open) {
          openTools.add(key);
          if (has) fill();
        } else openTools.delete(key);
      });
      return node;
    }
    case "note":
      return el("div", { class: "note" }, item.text);
    case "brain":
      return el("div", { class: `note brain ${item.stage}` }, item.text);
    case "switch":
      // The notice is the agent's, not the reader's: a move shows as one quiet line.
      return el("div", { class: "move" }, moveLine(item));
  }
}

// ---- the workspace panel: the session's files as a live tree (@pierre/trees); a file picked opens read-only (@pierre/diffs) ------------------------------------------------

let tree: TreeHandle | undefined;
let treePaths = "";
let treeWork: Promise<void> = Promise.resolve();

function renderFiles(): void {
  const files = state.files.filter((f) => !f.path.startsWith(".pi-tmp"));
  const paths = files.map((f) => (f.kind === "directory" ? `${f.path.replace(/\/$/, "")}/` : f.path));
  $("files-empty").hidden = paths.length > 0;
  const key = paths.join("\n");
  if (key === treePaths) return;
  treePaths = key;
  treeWork = treeWork.then(async () => {
    if (tree) tree.setPaths(paths);
    else tree = await mountTree($("files"), paths, (path) => void select(path));
  }).catch((e: unknown) => { $("files-empty").hidden = false; $("files-empty").textContent = `The file tree could not load: ${e instanceof Error ? e.message : String(e)}`; });
}

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** A workspace file's text, from this tab's computer (the writer) or from what a viewer was sent; undefined when it is not a readable file. */
async function readFileText(path: string): Promise<string | undefined> {
  return workspaceText(state.runtime, state.files.find((f) => f.path === path), path); // the tab's computer, the phone's files, or the pipe's copy
}

let shown = "";
const selecting = new Latest();
async function select(path: string): Promise<void> {
  const mine = selecting.next();
  state.selected = path;
  const row = state.files.find((f) => f.path === path);
  if (row?.kind !== "file") return;
  const text = (await readFileText(path)) ?? `(unreadable)`;
  if (!selecting.current(mine)) return; // a newer pick or refresh started while this one read: only the latest draws
  const key = `${path}\n${text}`;
  if (key === shown) {
    $("preview-name").textContent = `${path} · ${fmtSize(row.size)}`;
    return;
  }
  const view = await fileElement(path, text.slice(0, 20000));
  if (!selecting.current(mine)) return;
  shown = key;
  $("preview-name").textContent = `${path} · ${fmtSize(row.size)}`;
  document.body.classList.add("ws-open");
  $("preview").replaceChildren(view);
}

/** The page's own record of file texts it saw written, so a later write's diff is against the earlier one (the file's text before a write is not in the event). */
const memory = new WriteMemory();
function noteTools(events: readonly unknown[]): void {
  for (const e of events as { type?: string; toolName?: string; toolCallId?: string; isError?: boolean; args?: { path?: unknown; content?: unknown } }[]) {
    const seen = memory.observe(e);
    if (!seen || !e.toolCallId) continue;
    if (seen.before !== undefined) writeBefore.set(e.toolCallId, seen.before);
    else if (typeof e.args?.path === "string" && typeof e.args.content === "string") {
      const content = e.args.content;
      const id = e.toolCallId;
      void readFileText(e.args.path).then((t) => { if (t !== undefined && t !== content) { writeBefore.set(id, t); renderChat(); } }); // an existing file, read before the write lands (when it is quick enough)
    }
  }
}

/** The model's file reads and its first run share the main thread with the creature page: while it loads, the creature page is told to stop simulating and drawing, and to go on when the model is ready. */
let creatureQuiet = false;
let creatureLow = false;
function syncCreatureActivity(): void {
  if (!robotMode) return;
  const { paused: quiet, low } = creatureActivity({ brainLoading: state.brainLoading, phase: state.brain?.host.state().phase, localModelAnswering: state.chat.busy && state.brain?.conversation !== undefined && state.active === state.brain.conversation });
  if (quiet === creatureQuiet && low === creatureLow) return;
  creatureQuiet = quiet;
  creatureLow = low;
  (document.getElementById("creature") as HTMLIFrameElement | null)?.contentWindow?.postMessage({ ns: "walks-home", type: "set-activity", paused: quiet, low }, location.origin);
}

/** The typed model of the conversation that drives (its provider and id, read from the conversation itself), as last read; the header draws it. */
let driverModel: { provider: string; modelId: string } | null = null;
let driverReading = false;
let driverAgain = false;
function readDriver(): void {
  if (driverReading) {
    driverAgain = true;
    return;
  }
  const conversation = state.runtime ? target() : undefined;
  if (!conversation) {
    if (driverModel !== null) { driverModel = null; drawDriver(); }
    return;
  }
  driverReading = true;
  conversation.agent(ctx).then((a) => {
    const next = a.model ? { provider: a.model.provider, modelId: a.model.modelId } : null;
    if (next?.provider !== driverModel?.provider || next?.modelId !== driverModel?.modelId) { driverModel = next; drawDriver(); }
  }, () => undefined).finally(() => {
    driverReading = false;
    if (driverAgain) { driverAgain = false; readDriver(); }
  });
}

/** The model answering now, for the header: the typed model of the conversation that drives (the tab's small model by its short name, or the cloud model by its id). */
/** The last model the bar named: kept through a move and while the page reconnects, so "LLM:" does not blink out for a second and come back. */
let lastDriver = "";
function driverText(): string {
  if (state.mode === "viewer" && (state.placement?.where === "parked" || state.placement?.where === "checked-out")) return ""; // nothing runs it
  const settling = state.mode === "connecting" || state.mode === "booting" || state.mode === "lost" || state.leaving !== undefined || state.placement?.where === "moving";
  const label = state.mode === "connecting" || state.mode === "booting" || state.mode === "lost" || (state.mode === "offline" && driverModel === null) ? "" : driverNow();
  if (label !== "") lastDriver = label;
  return label !== "" ? label : settling ? lastDriver : "";
}
function driverNow(): string {
  // A page that only watches has no conversation of its own: the model is the one the relayed events say (the agent may have switched on its host), else the run's.
  const model = state.mode === "viewer" ? state.relayedModel : driverModel;
  return driverLabel({ model, tabProvider: BRAIN_PROVIDER, names: { [V5_MODEL_ID]: "Qwen3.5 0.8B", ...state.modelNames }, cloud: state.mode === "offline" ? "" : state.agentModel });
}
function drawDriver(): void {
  const driver = driverText();
  $("driver-name").textContent = driver;
  $("driver").hidden = driver === "";
}

function render(): void {
  syncCreatureActivity();
  const b = badge();
  const badgeEl = $("badge");
  badgeEl.className = `badge ${b.tone}`;
  $("badge-text").textContent = b.text;
  const here = state.mode === "writer" || state.mode === "offline";
  const swapped = here && state.brain?.conversation !== undefined && state.active === state.brain.conversation;
  badgeEl.title = [b.sub, here && state.brainStatus ? state.brainStatus : "", swapped ? "the agent's brain: the model it trained, running here" : "", state.checkout?.text ?? "", state.checkingIn?.text ?? ""].filter(Boolean).join(" · ");
  readDriver();
  drawDriver();
  $("banner").textContent = state.banner;
  $("banner").hidden = state.banner === "";
  const offline = state.mode === "offline";
  const writer = state.mode === "writer" && !state.leaving && !state.checkingOut && !state.brainPending && !state.rehoming;
  // Checked out to this browser: the trained model's conversation answers, once it is the active one.
  const offlineReady = offline && state.brain?.conversation !== undefined && state.active === state.brain.conversation;
  // Elsewhere, a message goes to whoever runs the run, through the server.
  const canSend = (phoneMode && offline && state.phone?.ready === true) || (v5Offline && offline && state.v5.ready && !state.checkingIn) || writer || (offlineReady && !state.checkingIn) || (state.mode === "viewer" && (state.placement?.where === "cloud" || state.placement?.where === "tab"));
  ($("input") as HTMLTextAreaElement).disabled = !canSend;
  ($("send") as HTMLButtonElement).disabled = !canSend;
  $("composer").hidden = !canSend && !phoneMode; // the phone always shows where to type (disabled until the brain is ready)
  fitHint(); // the field has a width once it is shown
  $("phone-retry").hidden = !(phoneMode && state.mode === "lost");
  // A fallback, not the switch: take the run from the cloud now, fencing it mid-step.
  $("takeover").hidden = !(state.mode === "viewer" && state.placement?.where === "cloud" && !state.switching);
  // "Take it offline": while this tab runs the agent and the trained model is its brain, and nothing is moving.
  const canTakeOffline = writer && (swapped || v5Offline || new URLSearchParams(location.search).get("brain") === "off") && !state.switching && !state.checkout; // v5: the model is kept in this browser, it is not a trained one that has come home
  canTakeOfflineNow = canTakeOffline;
  renderNet();
  // "Go online": while the run is checked out to this browser; it can be pressed once the server answers the ping, and nothing is already in progress.
  // Go online exists only with ?golive=1 (the check-in hands the one conversation back to the cloud model); outside it the checkout is one way. A check-in that was not confirmed can be sent again from any mode.
  $("checkedout").hidden = !offline || phoneMode;
  $("persist-warning").hidden = !(offline && state.offline && !state.offline.record.persistent);
  const operable = !offline && !phoneMode; // the operator's fallbacks: only where this page is a viewer or a writer of a run that can move
  $("switcher").hidden = !operable;
  renderSwitcher();
  const menuable = operable || !$("takeover").hidden;
  ($("badge-text") as HTMLButtonElement).classList.toggle("has-menu", menuable);
  if (!menuable) closeMenu();
  renderChat();
  renderFiles();
  renderStats();
}

function renderStats(): void {
  if (phoneMode) {
    const p = state.phone, last = p?.model?.turns.at(-1);
    // while a turn runs, the place you type says what the robot is doing, with the time it has taken
    if (p?.ready) setHint(state.chat.busy ? `the robot is thinking… ${p.turnStarted ? `${Math.round((performance.now() - p.turnStarted) / 1000)} s` : ""}` : "Tell the robot what to do: paint it red, make it a spider, spin…");
    $("new-chat").hidden = !p?.ready;
    $("phone-files").hidden = !p; // the files are there before the brain is
    ($("new-chat") as HTMLButtonElement).disabled = state.chat.busy;
    $("stats").textContent = p ? [p.marks.loadMs ? `model loaded in ${(p.marks.loadMs / 1000).toFixed(1)} s` : "", p.marks.warmMs ? `prompt read in ${(p.marks.warmMs / 1000).toFixed(1)} s (${p.marks.warmTokens} tokens)` : "", last ? `last turn ${(last.ms / 1000).toFixed(1)} s, ${last.timings?.prompt_n ?? "?"} new prompt tokens, ${last.outputTokens} out` : ""].filter(Boolean).join(" · ") : "";
    return;
  }
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
  // A server without the package answers 404: say so, instead of handing the 404's body to the loader and waiting for ever.
  if (!response.ok) throw new Error(`the computer's package could not be loaded (the server answered ${response.status} for ${COMPUTER}); build it with: node tab/build.mjs --fetch`);
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
    const bytes = await (prefetched ?? fetchComputer((got, total) => ($("badge").title = `downloading the computer: ${fmtSize(got)}${total ? ` of ${fmtSize(total)}` : ""}`)));
    state.progress = "loading the computer";
    render();
    computer = await wasmer.packages.load(bytes);
    state.computerMs = performance.now() - started;
    return computer;
  })();
  loading.catch(() => (loading = undefined));
  return loading;
}

/** A Wasmer sandbox on the computer's package, as the agent's hands: its environment and its workspace (not yet restored). */
async function bootComputer(): Promise<{ env: WasmerEnv; workspace: Workspace; facts: ReturnType<typeof tabFacts> }> {
  const pkg = await ensureComputer();
  const sandbox = await wasmer!.sandboxes.create({ packages: [pkg], shell: pkg.command("bash"), env: { LANG: "C.UTF-8" } });
  // No core or memory count: navigator.hardwareConcurrency and deviceMemory describe the machine the browser runs on, not what this sandbox can use.
  const env = new WasmerEnv(sandbox as never, { id: `wasmer:${run}`, env: { HOME: "/workspace", LANG: "C.UTF-8", TERM: "dumb" } });
  return { env, workspace: new Workspace(wasmerWorkspaceFs(env)), facts: tabFacts(pkg.commands) };
}

async function runHere(attached: Attached, client: PipeClient): Promise<void> {
  state.mode = "booting";
  state.generation = attached.generation;
  state.progress = `restoring ${attached.files.filter((f) => f.kind === "file").length} files from the disk`;
  render();
  const started = performance.now();
  const { env, workspace, facts } = await bootComputer();
  state.environments = attached.environments;
  herePlace = tabPlace(attached.environments) ?? herePlace;
  state.agentModel = attached.model;
  state.app = attached.app;
  state.placed = attached.placed === true;
  const runtime = await startTab({ client, attached, env: withHomeFallback(env, readWorkFresh), workspace, robotCode: robotCodeOn, ...placed(), host: { switchChannel, offlineChannel }, ...(attached.move ? { move: { info: attached.move, facts } } : {}) });
  if (attached.move) client.send({ t: "switched", switchId: attached.move.id });
  state.runtime = runtime;
  installCloud(runtime);
  // With ?golive=1 the router can leave the conversation on the small model; a page opened again has no model loaded until it goes offline, so the conversation goes back to the cloud model before input is accepted.
  if (golive && (await runtime.root.agent(ctx)).model?.provider === BRAIN_PROVIDER) await runtime.root.configure(cloudAgent(attached.model, { registry: runtime.registry, robotCode: robotCodeOn, ...appOption(), ...placed() }), ctx);
  state.bootMs = performance.now() - started;
  state.mode = "writer";
  state.progress = "";
  state.banner = "";
  // The page can run a line now: the server holds the lines typed while it was away until it hears this.
  client.send({ t: "writer-ready" });
  // A swap from an earlier visit: the chat input waits for the saved conversation (a message sent now would go to the cloud conversation and be missing from the one that comes back).
  state.brainPending = !golive && new URLSearchParams(location.search).get("brain") !== "off" && (await findSwap(runtime.root, ctx).catch(() => undefined)) !== undefined;
  if (state.brainPending) state.brainStatus = "the trained model is loading; you can talk to it as soon as it is ready";
  submitGate.open(); // what the server sent while this page was taking the run over (its home turn) runs now
  // the laptop's offline brain is kept in this browser while there is a network, a moment after the page is up (the first visit downloads 501 MB; later ones find it cached)
  if (v5Offline) setTimeout(() => void prefetchV5().catch(() => undefined), 3000);
  await followConversation(runtime, runtime.root);
  void watchForBrain(runtime);
  await refreshFiles();
  render();
  ($("input") as HTMLTextAreaElement).focus();
}

/** The root's entries are folded in front of a later conversation's, so a viewer sees one continuous chat: the trip, the swap, then the new conversation. */
let followed: AgentEventStream | undefined;

/** Fold and relay one conversation's events from now on (`before`: the entries of the conversation that came first, shown ahead of its own). */
async function followConversation(runtime: TabRuntime, conversation: Conversation, before: readonly EntryRecord[] = []): Promise<void> {
  const old = followed;
  followed = undefined;
  await old?.stop().catch(() => undefined);
  const stream = await watchEvents(runtime.harness, conversation.id, ctx);
  const merge = (event: AgentEvent): AgentEvent => (event.type === "snapshot" && before.length > 0 ? { ...event, entries: [...before, ...event.entries] } : event);
  state.active = conversation;
  state.chat = new ChatView();
  state.sent = [];
  const snapshot = merge(stream.snapshot);
  state.chat.apply(snapshot);
  const notRoot = conversation.id === runtime.root.id ? {} : { root: false as const };
  state.client?.view({ kind: "snapshot", ...notRoot, event: snapshot } satisfies ViewEvent);
  stream.start(async (events) => {
    const folded = events.map(merge);
    noteTools(folded);
    for (const event of folded) state.chat.apply(event);
    if (phoneMode) for (const event of folded) {
      // a turn that failed (the model, its watchdog, the window) is in the chat as a note; the phone's report says it too
      const m = event.type === "message_end" ? ((event.entry as unknown as { model?: { role?: string; stopReason?: string; errorMessage?: string }[] }).model ?? [])[0] : undefined;
      if (m?.role === "assistant" && m.stopReason === "error") phoneReport("turn-failed", { error: String(m.errorMessage ?? "").slice(0, 300) });
    }
    state.client?.view({ kind: "events", ...notRoot, events: folded } satisfies ViewEvent);
    if (events.some((e) => e.type === "tool_execution_end" || e.type === "run_end")) await refreshFiles();
    renderChat();
    renderStats();
  });
  followed = stream;
  renderChat();
}

/** A file of the run's disk (work/) over HTTP, with the run's secret as the bearer token; null when it is not there. Files under a lazy prefix (the model's folder) are read this way too. */
/** The same file, past the service worker's cache (`?fresh`): after a checkout the worker answers the manifest from its cache first, and a poll for a NEW manifest must reach the server. */
async function readWorkFresh(path: string): Promise<Uint8Array | null> {
  const r = await fetch(`/api/runs/${encodeURIComponent(run)}/work/${path}?fresh=1`, { headers: { authorization: `Bearer ${secret}` }, cache: "no-store" });
  return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
}

async function readWork(path: string): Promise<Uint8Array | null> {
  const r = await fetch(`/api/runs/${encodeURIComponent(run)}/work/${path}`, { headers: { authorization: `Bearer ${secret}` }, cache: "no-store" });
  return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
}

/** The dark-content judge (opt-in, `?judge=on`), between the model's stream and everything that shows it: anything but a clean "show" holds the answer. */
async function judgeAnswer(prompt: string, answer: string): Promise<"show" | "refuse"> {
  if (state.offline) return "show"; // checked out to this browser: there is no safety check, by decision
  try {
    const topic = state.brain?.host.state().topic;
    const r = await fetch(`/api/runs/${encodeURIComponent(run)}/judge`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt, answer, ...(topic ? { topic } : {}) }),
      signal: AbortSignal.timeout(5000),
    });
    return verdictOf(r.status, await r.json().catch(() => null));
  } catch {
    return "refuse"; // fail closed: no answer, no timeout, no verdict means nothing is shown
  }
}

/**
 * When the trained model's manifest is on the run's disk (the trainer writes it last) and this tab runs the agent, load the model and make it the agent's
 * brain (brain.ts). Polls once in two seconds; tries once (a failure is written to the transcript and stays: a reload tries again).
 */
async function watchForBrain(runtime: TabRuntime): Promise<void> {
  try {
    await swapWhenHome(runtime);
  } finally {
    if (state.runtime === runtime) { state.brainPending = false; render(); } // ready, failed or never coming: from here a message has somewhere to go
  }
}

/** Wait (up to a minute) for the trip's agent to finish its turn, so its last results are in the transcript the new chat is built on and the live watch can end. */
async function settleRoot(runtime: TabRuntime): Promise<void> {
  const until = performance.now() + 60_000;
  while (performance.now() < until && state.runtime === runtime) {
    if ((await finishStep(runtime.harness, 5_000)) === "idle") return;
  }
}

async function swapWhenHome(runtime: TabRuntime): Promise<void> {
  if (new URLSearchParams(location.search).get("brain") === "off" || golive) return; // golive: the model takes over when the agent goes offline, not before
  for (;;) {
    if (state.runtime !== runtime || state.mode !== "writer") return;
    let text: string | null = null;
    try { text = await readManifest(readWork); } catch { text = null; }
    if (text && !(await prefetchBase(text))) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  await startBrain(runtime);
}

/** Model files kept whole by sha256 in this browser (OPFS): a base fetched once serves every adapter that comes home after it, and an offline reload reads nothing. */
const modelFiles = opfsFileStore();
const sha256hex = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource))].map((x) => x.toString(16).padStart(2, "0")).join("");
let prefetchedBase = "";

/**
 * A base-and-adapters manifest that lists no adapter yet (the trainer writes it when training starts): the base comes home now, while the agent trains, so the
 * skill or obsession that follows is an adapter of tens of MB. True while there is no brain to swap to.
 */
async function prefetchBase(text: string): Promise<boolean> {
  let home;
  try { home = await describeHome(text, sha256hex); } catch { return false; } // not a manifest the brain can read: the brain says why
  if (home.ready) return false;
  if (prefetchedBase !== home.id) {
    prefetchedBase = home.id;
    state.brainStatus = "the base model is coming home while the agent trains";
    state.brainLoading = true;
    render();
    try {
      const h = await comeHome(text, { readChunk: readWork, sha256: sha256hex, store: modelFiles, now: () => performance.now() });
      state.homecomings.push({ prefetch: true, plan: h.fetched.plan, fetched_bytes: h.fetched.bytes, fetch_ms: Math.round(h.fetched.ms), name: h.name });
      announce("homecoming", { phase: "fetched", prefetch: true, plan: h.fetched.plan, fetched_bytes: h.fetched.bytes, fetch_ms: Math.round(h.fetched.ms), name: h.name });
      state.brainStatus = "the base model is in this browser; the agent is still training";
    } catch (e) {
      prefetchedBase = "";
      state.brainStatus = `the base model did not come home: ${(e as Error).message}`;
    }
    state.brainLoading = false;
    render();
  }
  return true;
}

/**
 * ?template=native (the robot demo): a model with its OWN tool template (MiniCPM5-2B) is the brain. It is loaded with its jinja and a context that holds the tools, sees the robot tools and the
 * D1-scored system prompt, and its `skill` lock is the skills that actually came home (home/skills.json), so the model cannot name a skill the robot does not have.
 */
let robotSkills: string[] = [];
async function refreshRobotSkills(): Promise<void> {
  const bytes = await readWorkFresh("home/skills.json").catch(() => null);
  try { robotSkills = bytes ? Object.keys(parseSkills(new TextDecoder().decode(bytes)).skills) : []; } catch { robotSkills = []; }
}
const NATIVE_CTX = 4096;
function nativeBrainConfig(runtime: TabRuntime) {
  const tools = runtime.registry.snapshot().tools().filter((t) => (ROBOT_TOOLS as readonly string[]).includes(t.tool.name) && t.tool.name !== "build_robot").map((t) => t.tool);
  return {
    native: { nCtx: NATIVE_CTX },
    instructions: ROBOT_SYSTEM,
    decoding: { mode: "native" as const, system: ROBOT_SYSTEM, nCtx: NATIVE_CTX, history: "none" as const, onTurn: (t: { ms: number; tokensPerSecond: number | null; completions: unknown[]; prompt: string; decoded: { promptTokens: number; outputTokens: number; thinkTokens: number; calls: number; thinkingCut: boolean; cut: boolean; raw: string; parsed: { call?: { name: string; arguments: unknown }; problem?: { kind: string; detail: string } } } }) => { const d = t.decoded; state.toolTurns.push({ ms: Math.round(t.ms), tokensPerSecond: t.tokensPerSecond === null ? null : Math.round(t.tokensPerSecond * 10) / 10, promptTokens: d.promptTokens, outputTokens: d.outputTokens, thinkTokens: d.thinkTokens, calls: d.calls, thinkingCut: d.thinkingCut, cut: d.cut, call: d.parsed.call ? JSON.stringify(d.parsed.call) : null, problem: d.parsed.problem ? `${d.parsed.problem.kind}: ${d.parsed.problem.detail}` : null, raw: d.raw, completions: t.completions, prompt: t.prompt }); }, prepare: refreshRobotSkills, refine: (list: ReturnType<typeof toNativeTools>) => (robotSkills.length ? narrowEnum(list, "skill", robotSkills) : list) },
    mode: "configure" as const,
    tools,
  };
}


/**
 * Load the trained model and make it the agent's brain (brain.ts), then follow its conversation. `adopt`: a host that already holds the loaded model (taking the
 * run offline keeps it). Offline, the manifest and the chunks are read from the service worker's cache through the same `readWork`.
 */
async function startBrain(runtime: TabRuntime, adopt?: ModelHost, route = false): Promise<void> {
  const params = new URLSearchParams(location.search);
  const threads = Number(params.get("threads")) || Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 2));
  const history = params.get("history") === "none" ? "none" : "last";
  const native = params.get("template") === "native";
  if (native) await refreshRobotSkills();
  const brain = new Brain({
    ...(route ? { route: true } : {}), harness: runtime.harness, models: runtime.models, root: runtime.root, readFile: readWork, judge: judgeFor(params.get("judge") === "on", judgeAnswer), context: ctx, threads, history,
    // ?configure=1 (a spike, not the default): ONE conversation, configured onto the model with the four coding tools, instead of a fresh one
    ...(native ? nativeBrainConfig(runtime) : params.get("configure") === "1" || golive ? { decoding: { history: (params.get("toolhistory") ?? (golive ? "last" : "none")) === "last" ? ("last" as const) : ("none" as const), thinkTokens: Number(params.get("think")) || 64, answerTokens: Number(params.get("answer")) || 200, callTokens: Number(params.get("call")) || 512, mode: params.get("decode") === "free" ? ("free" as const) : params.get("decode") === "grammar" ? ("grammar" as const) : ("lazy" as const), onTurn: (t: { ms: number; tokensPerSecond: number | null; completions: unknown[]; prompt: string; decoded: { promptTokens: number; outputTokens: number; thinkTokens: number; calls: number; thinkingCut: boolean; cut: boolean; raw: string; parsed: { call?: { name: string; arguments: unknown }; problem?: { kind: string; detail: string } } } }) => { const d = t.decoded; state.toolTurns.push({ ms: Math.round(t.ms), tokensPerSecond: t.tokensPerSecond === null ? null : Math.round(t.tokensPerSecond * 10) / 10, promptTokens: d.promptTokens, outputTokens: d.outputTokens, thinkTokens: d.thinkTokens, calls: d.calls, thinkingCut: d.thinkingCut, cut: d.cut, call: d.parsed.call ? JSON.stringify(d.parsed.call) : null, problem: d.parsed.problem ? `${d.parsed.problem.kind}: ${d.parsed.problem.detail}` : null, raw: d.raw, completions: t.completions, prompt: t.prompt }); } }, mode: "configure" as const, tools: runtime.registry.snapshot().tools().filter((t) => (golive ? ["read", "write", "bash", "go_online"] : ["read", "write", "edit", "bash"]).includes(t.tool.name)).map((t) => t.tool) } : {}),
    llm: wllamaLlm(new URL("/vendor/wllama.wasm", location.origin).href),
    files: modelFiles,
    onProgress: (type, b) => {
      if (type === "model-homecoming") {
        state.homecomings.push({ ...b, fetch_ms: Math.round(Number(b.fetch_ms)) });
        announce("homecoming", { phase: "fetched", prefetch: false, plan: b.plan, fetched_bytes: b.fetched_bytes, fetch_ms: Math.round(Number(b.fetch_ms)), active: b.active, adapters: b.adapters, name: b.name, bytes: b.bytes });
      }
      if (type === "model-loaded" && state.homecomings.length) {
        Object.assign(state.homecomings.at(-1)!, { load_ms: Math.round(Number(b.load_ms)), download_ms: Math.round(Number(b.download_ms)) });
        announce("homecoming", { phase: "loaded", load_ms: Math.round(Number(b.load_ms)), sha256: b.sha256, bytes: b.bytes });
      }
      if (type === "model-loading" || type === "model-download") state.brainLoading = true;
      if (type === "model-switched" || type === "model-failed") state.brainLoading = false;
      if (type === "model-loading") state.brainStatus = `the trained model is coming home: ${String(b.name)}`;
      else if (type === "model-download") state.brainStatus = `the trained model is coming home: chunk ${String(b.done_chunks)} of ${String(b.total_chunks)}`;
      else if (type === "model-loaded") state.brainStatus = "the trained model is loaded; it answers one question as a check";
      else if (type === "model-failed") state.brainStatus = `the trained model did not load: ${String(b.reason)}`;
      else if (type === "model-switched") state.brainStatus = "";
      render();
    },
  }, adopt);
  state.brain = brain;
  const manifest = await readManifest(readWork);
  if (!manifest) return;
  const conversation = await brain.start(manifest);
  if (!conversation || state.runtime !== runtime) return;
  if (native) {
    // the same view of the tools the first real turn will send, so the prefix the warm-up fills is the prefix that turn reuses
    const config = nativeBrainConfig(runtime);
    const view = config.decoding.refine(toNativeTools(config.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))));
    void brain.warm(ROBOT_SYSTEM, view).then((ms) => { if (ms !== undefined) { state.brainStatus = ""; render(); } });
  }
  state.brainStatus = "the agent is finishing its turn";
  render();
  await settleRoot(runtime);
  if (state.runtime !== runtime) return;
  // the trip's transcript, in front of the new conversation's own
  const rootWatch = await watchEvents(runtime.harness, runtime.root.id, ctx);
  const before = conversation.id === runtime.root.id ? [] : rootWatch.snapshot.entries; // one conversation: its own entries are the whole chat
  await rootWatch.stop();
  await followConversation(runtime, conversation, before);
  state.brainStatus = "";
  render();
  ($("input") as HTMLTextAreaElement).focus();
  void watchRehome(runtime, brain);
}

/**
 * More models can come home after the first: the trainer writes a new manifest (another adapter over the same base). While this tab runs the agent and has a brain, the manifest is watched every 2 s; a new
 * id loads in place of the old model (only what the file store lacks is fetched) and the conversation is configured onto it, as many times as the run brings models home. A conversation that is running
 * on the small model waits until the agent is idle first (the model it is configured on is replaced); one that is running on the cloud is left alone.
 */
async function watchRehome(runtime: TabRuntime, brain: Brain): Promise<void> {
  for (;;) {
    await sleepMs(2000);
    if (state.runtime !== runtime || state.brain !== brain || state.mode !== "writer") return;
    let id: string, text: string | null;
    try {
      text = await readManifest(readWorkFresh);
      state.watch.polls++;
      if (!text) continue;
      const home = await describeHome(text, sha256hex);
      state.watch.seen = home.id;
      if (!home.ready || home.id === brain.currentId) continue;
      id = home.id;
    } catch (error) {
      state.watch.error = (error as Error).message;
      continue; // not readable now: asked again
    }
    try {
      if ((await brain.current()) === "tab-local" && (await untilIdle(runtime.harness, 120_000)) !== "idle") continue;
      if (state.runtime !== runtime || state.brain !== brain) return;
      state.brainStatus = "a new model is coming home";
      state.rehoming = true;
      render();
      let result: Awaited<ReturnType<Brain["rehome"]>>;
      try {
        result = await brain.rehome(text, cloudAgent(state.agentModel, { registry: runtime.registry, robotCode: robotCodeOn, ...appOption(), ...placed() }));
      } finally {
        state.rehoming = false;
      }
      state.brainStatus = result === "failed" ? "the new model did not load" : "";
      announce("homecoming", { phase: "swapped", result, id, rehomes: brain.rehomes });
    } catch (error) {
      state.brainStatus = `the new model did not come home: ${(error as Error).message}`;
    }
    render();
  }
}

/** Where the chat input goes. */
const target = (): Conversation | undefined => state.active ?? state.runtime?.root;

/** A line the server placed for this run: a user's goes through the brain router like one typed in this page, one at a time in the order they came, and waits while a checkout, a model swap or a rehome holds the page, instead of being lost; the server's own turn goes straight to the conversation. */
function runServerLine(frame: { text: string; requestId: string }): void {
  const { text, requestId } = frame;
  const kind = submitFrameKind(requestId);
  sendLine = sendLine
    .then(async () => {
      for (let waited = 0; (state.checkingOut || state.brainPending || state.rehoming) && waited < 120_000; waited += 100) await new Promise((r) => setTimeout(r, 100));
      if (!(state.runtime && state.mode === "writer") || state.checkingOut || state.brainPending || state.rehoming) return;
      if (kind === "server") await target()?.submit({ type: "input", content: text, requestId }, ctx);
      else await decideAndSubmit(text, requestId);
    })
    .catch((error: Error) => {
      state.banner = `not sent: ${error.message}`;
      render();
    });
}
const submitGate = new SubmitGate<{ text: string; requestId: string }>(runServerLine);

async function refreshFiles(): Promise<void> {
  if (!state.runtime) return;
  state.files = (await state.runtime.workspace.list()).map((f) => ({ path: f.path, kind: f.kind, size: f.size }));
  renderFiles();
  if (state.selected) void select(state.selected);
}

// ---- checked out to this browser ---------------------------------------------------------------------------------------------

/**
 * "Take it offline", from the page that runs the agent on the trained model: the page, its assets and the model go into the service worker's cache (nothing is
 * changed on the server until that is whole), a consistent copy of the run's store comes into OPFS and is read back, and the pipe is asked to hand the run over:
 * it releases the claim only when the copy's head is the store's head. Then this page runs the agent from OPFS, the same model still loaded, with no pipe.
 * A refused or failed step leaves the run where it was: this tab's.
 */
async function takeOffline(): Promise<void> {
  const runtime = state.runtime, brain = state.brain, conversation = brain?.conversation;
  // ?brain=off: the run has no model of its own (a check of the computer alone), and is checked out without one.
  const noBrain = new URLSearchParams(location.search).get("brain") === "off";
  if (!runtime || state.mode !== "writer" || state.checkout || state.switching) return;
  // the laptop's offline brain is v5, kept in this browser (not a model that comes home from the run's disk): no manifest, no running Brain needed
  const v5 = v5Offline && !noBrain;
  if (!noBrain && !golive && !v5 && (!brain || !conversation || state.active !== conversation)) return;
  const say = (text: string) => { state.checkout = { text }; render(); };
  // From the click on, nothing new starts: the chat input is held and a viewer's message is not acted on, so the agent stays idle through the caching and the copy.
  state.checkingOut = true;
  state.handoverAsked = false;
  state.savedLoss = undefined;
  let uncertain = false;
  try {
    say("waiting for the agent to be idle");
    if ((await untilIdle(runtime.harness, 30_000)) !== "idle") throw new Error("the agent is answering: wait for the answer, then take it offline");
    const manifestText = noBrain || v5 ? null : await readManifest(readWorkFresh); // the manifest as the server has it now, not as the service worker cached it
    if (!noBrain && !v5 && !manifestText) throw new Error("the model's manifest is not on the run's disk");
    const home = manifestText ? await describeHome(manifestText, sha256hex) : undefined;
    const manifest = home ? { sha256: home.id, size: home.bytes, chunks: home.chunks } : { sha256: "", size: 0, chunks: [] };
    say("registering the service worker");
    await registerOfflineWorker();
    const cached = await cacheRunForOffline({ run, secret, manifestText, onProgress: (p) => say(`caching the page and the model in this browser: ${p.done} of ${p.total}`) });
    if (v5) {
      // the robot's brain goes into this browser's cache NOW (parts and warm state in wllama's OPFS cache, its small files in the service worker's): after the handover there is no server to ask
      say("keeping the robot's brain in this browser");
      await prefetchV5((text) => say(text));
      await cacheFilesForOffline(v5SmallFiles(v5Urls(new URLSearchParams(location.search))));
    }
    // A base and adapters are kept whole in the browser's file store, not as the service worker's chunks: after the handover the server cannot be read for them, so they come home NOW (only what the store lacks).
    if (manifestText && isBaseAdapters(manifestText)) {
      say("bringing the model's files into this browser");
      await comeHome(manifestText, { readChunk: readWork, sha256: sha256hex, store: modelFiles, now: () => performance.now(), onProgress: (p) => say(`bringing the model's files into this browser: ${p.done} of ${p.total}`) });
    }
    if ((await untilIdle(runtime.harness, 30_000)) !== "idle") throw new Error("the agent started answering while the model was cached: try again");
    // The browser is asked to keep this site's storage: once the run is handed over, this is the only copy. A browser that will not is a warning (a refusal with ?persist=require).
    const persistent = (await navigator.storage?.persisted?.().catch(() => false)) || (await navigator.storage?.persist?.().catch(() => false)) || false;
    if (!persistent && new URLSearchParams(location.search).get("persist") === "require") throw new Error("this browser would not promise to keep this site's storage, so the only copy of the run could be removed under storage pressure: nothing was handed over");
    // The workspace (work/, less the model) goes into OPFS too: the computer boots from it with no network. The tab is idle and every write-through was acknowledged, so this is what the pipe holds.
    say("saving the workspace in this browser");
    await creatureGate.drain(); // the creature page's writes in flight land first (new ones are held: checkingOut)
    const scanned = new Map(await runtime.workspace.scan());
    // With the robot pane the creature page reads the policies and the skills offline from the workspace: they are in the server's home/ (not restored into the tab), so they come in now, as files of the saved copy
    if (robotMode) for (const [path, entry] of await homeFilesForOffline()) if (!scanned.has(path)) scanned.set(path, entry as never); // only their bytes are used from here on (saved copy, baseline)
    const workspace = await saveWorkspace(run, scanned);
    await saveBaseline(run, await baselineOf(scanned as Snapshot)); // what the server holds now: at check-in, the changes are what the workspace holds against this
    let head = -1;
    let record: CheckoutRecord | undefined;
    for (let attempt = 0; attempt < 3 && head < 0; attempt++) {
      say("copying the run's store from the server");
      const copy = await fetchStoreCopy(run, secret);
      await importStore(run, copy.bytes);
      const check = await openLocalStore(run);
      const copied = await check.head();
      await check.storage.close(ctx);
      if (copied !== copy.head) throw new Error(`the copy in this browser is at ${copied}, the server's store at ${copy.head}`);
      record = { run, state: "copied", head: copy.head, model: state.agentModel, conversation: conversation ? Number(conversation.id) : undefined, tab, at: Date.now(), manifestSha: manifest.sha256, chunks: manifest.chunks.length, bytes: cached.bytes, workspace, persistent };
      await writeCheckout(record);
      say("handing the run over");
      if (state.savedLoss) throw new Error("the connection to the run was lost while the checkout was preparing");
      state.handoverAsked = true;
      const outcome = await confirmHandover(() => requestCheckout({ run, secret, tab, head: copy.head, conversation: record!.conversation }));
      if (outcome.state === "refused") state.handoverAsked = false; // nothing was handed over: a closing socket is a loss again
      if (outcome.state === "done") head = outcome.head;
      else if (outcome.state === "unknown") {
        // The pipe never answered: it may have released the run or not. This tab does not run the old writer again (it could fork the run); the copy is kept, and a reload asks again.
        uncertain = true;
        throw new Error("the server did not answer the handover, so it is not known whether it was made. This browser keeps its complete copy; reload this page when the server can be reached and it will ask again");
      } else if (!(outcome.error.code === "HEAD_MISMATCH" && attempt < 2)) throw outcome.error; // the store moved after the copy: copy again
    }
    if (head < 0 || !record) throw new Error("the store kept changing: not handed over");
    record = { ...record, state: "done", head };
    await writeCheckout(record);
    await leaveForOffline(record, brain && home && brain.currentId === home.id ? brain.host : undefined); // the loaded model is adopted only when it is the one the manifest names
  } catch (error) {
    state.checkout = undefined;
    if (uncertain) {
      state.mode = "lost";
      state.banner = (error as Error).message;
    } else {
      state.checkingOut = false;
      state.handoverAsked = false;
      state.banner = `could not take it offline: ${(error as Error).message}`;
      // The pipe was lost while the checkout was preparing: that loss is handled now, as it would have been (the page says so and reconnects), never left as a dead writer.
      const saved = (state as { savedLoss: { client: PipeClient; code: string; message: string } | undefined }).savedLoss; // set by lost() while this ran
      state.savedLoss = undefined;
      if (saved) {
        render();
        await lost(saved.client, saved.code, saved.message);
        return;
      }
    }
    render();
  }
}

// ---- the laptop's offline brain (v5) -------------------------------------------------------------------------------------
// The same model and the same code the phone runs (v5-brain.ts). While online, with the robot pane, its files are kept in this browser (`prefetchV5`: wllama's OPFS
// cache, checked as a load checks them); "Take it offline" waits for that and then only checks them out; the offline page loads the model from the cache.

let v5Prefetching: Promise<void> | undefined;

/** Keep v5's parts and warm state in this browser's cache, once; `say` is told how far it is. Fails by name when this page's server does not serve the files. */
function prefetchV5(say?: (text: string) => void): Promise<void> {
  const v5 = state.v5;
  if (v5.prefetch === "done") return Promise.resolve();
  const tell = (text: string) => { v5.prefetchText = text; say?.(text); if (state.mode === "writer" && !state.checkingOut) { state.brainStatus = text; render(); } };
  v5Prefetching ??= (async () => {
    const urls = v5Urls(new URLSearchParams(location.search));
    if (!(await served(v5SmallFiles(urls)[0]!))) { v5.prefetch = "unavailable"; throw new Error(`this page's server does not serve the robot's brain (${new URL(urls.modelUrl).pathname.replace(/-00001-of-\d{5}\.gguf$/, "")}): start it with --models-dir`); }
    v5.prefetch = "running";
    const llm = wllamaForPrefetch(new URL("/vendor/wllama.wasm", location.origin).href);
    // ?clearcache=1 is asked here, before the files are kept, and taken off the address: the brain loaded after the handover must not clear what the checkout just saved
    const params = new URLSearchParams(location.search);
    if (params.get("clearcache") === "1") {
      await llm.clearCache?.();
      const u = new URL(location.href); u.searchParams.delete("clearcache"); history.replaceState(null, "", u);
      v5.log.push("model cache cleared before it was kept");
    }
    const model = new PhoneModel(llm, {
      url: urls.modelUrl, threads: 1, nCtx: 2048, batch: 128, maxTokens: 300,
      onProgress: (loaded, total) => tell(`keeping the robot's brain in this browser: ${Math.round(loaded / 1e6)} of ${Math.round(total / 1e6)} MB`),
      onStatus: (text) => tell(`keeping the robot's brain in this browser: ${text}`),
    });
    const got = await model.prefetch(urls.stateUrl ? { url: urls.stateUrl } : undefined);
    v5.prefetch = "done";
    v5.log.push(`the robot's brain is kept in this browser: ${got.files} files, ${Math.round(got.bytes / 1e6)} MB`);
    if (state.mode === "writer") { state.brainStatus = ""; render(); }
  })().catch((e: Error) => {
    if (v5.prefetch !== "unavailable") v5.prefetch = "failed";
    v5.prefetchText = e.message;
    v5Prefetching = undefined; // asked again at the next try
    if (state.mode === "writer") { state.brainStatus = ""; render(); }
    throw e;
  });
  return v5Prefetching;
}

/** Load v5 from this browser's cache and put the conversation on it; the composer opens when it can answer. */
async function startLaptopBrain(runtime: TabRuntime): Promise<void> {
  const v5 = state.v5;
  await disposeV5(); // a brain from before a failed check-in: its engine is let go before the next one loads
  v5.ready = false;
  v5.marks = {};
  state.brainStatus = "the robot's brain is loading from this browser's cache";
  render();
  try {
    v5.brain = await startV5Brain(runtime, {
      params: new URLSearchParams(location.search), marks: v5.marks,
      say: (phase, line) => { state.brainStatus = phase; if (line) v5.log.push(`${(performance.now() / 1000).toFixed(1)} s ${line}`); render(); },
      log: (line) => v5.log.push(line),
      report: (kind, data) => announce("v5", { kind, ...data }),
      conversation: () => state.active ?? runtime.root,
      restoreWasmGlobals: true, // this page's computer runs wasm too: wllama's build patches of the wasm globals are put back once the model is loaded
    }, () => {
      v5.ready = true;
      state.brainStatus = "";
      setHint("Tell the robot what to do: paint it red, give it a face, spin…");
      render();
      ($("input") as HTMLTextAreaElement).focus();
    });
  } catch (error) {
    state.brainStatus = "";
    state.banner = `the robot's brain did not load: ${(error as Error).message}`;
    render();
  }
}

/** Let go of the loaded v5 engine (its memory and workers). */
async function disposeV5(): Promise<void> {
  const brain = state.v5.brain;
  state.v5.brain = undefined;
  state.v5.ready = false;
  await brain?.model.dispose().catch(() => undefined);
}

/** The run was handed over: drop the pipe and the pipe-backed Harness, and run from this browser's copy. */
async function leaveForOffline(record: CheckoutRecord, host: ModelHost | undefined): Promise<void> {
  state.checkingOut = true;
  const old = state.runtime;
  state.client?.close();
  state.client = undefined;
  state.runtime = undefined;
  state.active = undefined;
  state.brain = undefined;
  await followed?.stop().catch(() => undefined);
  followed = undefined;
  await old?.close().catch(() => undefined);
  await startOffline(record, host);
}

/** Run the agent from this browser's copy of the run's store: no pipe, no computer, the model from the cache (or the one already loaded). */
async function startOffline(record: CheckoutRecord, adopt?: ModelHost): Promise<void> {
  state.mode = "booting";
  state.progress = "opening this browser's copy of the run";
  state.banner = "";
  state.checkout = undefined;
  render();
  try {
    const marks: Record<string, number> = {};
    const t = performance.now();
    const store = await openLocalStore(run);
    marks.storeMs = Math.round(performance.now() - t);
    // The computer, from the cache and this browser's copy of the workspace; a computer that will not start is said, and the chat still runs.
    const computerStatus: { booted: boolean; ms: number; files: number; error?: string; parts?: Record<string, number> } = { booted: false, ms: 0, files: 0 };
    let computer: { env: WasmerEnv; workspace: Workspace } | undefined;
    state.progress = "starting the computer from this browser's cache";
    render();
    const started = performance.now();
    try {
      const c = await bootComputer();
      marks.bootMs = Math.round(performance.now() - started);
      const saved = await loadWorkspace(run);
      marks.loadMs = Math.round(performance.now() - started) - marks.bootMs;
      const restored = await c.workspace.restore(saved);
      marks.restoreMs = Math.round(performance.now() - started) - marks.bootMs - marks.loadMs;
      computer = { env: c.env, workspace: c.workspace };
      Object.assign(computerStatus, { booted: true, files: restored.files });
    } catch (error) {
      computerStatus.error = (error as Error).message;
    }
    computerStatus.ms = Math.round(performance.now() - started);
    computerStatus.parts = marks;
    const runtime = await startLocal({ storage: store.storage, model: record.model, robotCode: robotCodeOn, ...placed(), host: { offlineChannel }, ...(v5Offline && new URLSearchParams(location.search).get("brain") !== "off" ? { deferResume: true } : {}), /* resumed by startV5Brain once its provider exists */ ...(computer ? { computer, persist: (changes) => applyChanges(run, changes) } : {}) });
    state.offline = { record, store, computer: computerStatus };
    state.runtime = runtime;
    state.environments = [];
    state.mode = "offline";
    state.checkingOut = false;
    state.progress = "";
    state.banner = computerStatus.error ? `the computer did not start in this browser: ${computerStatus.error}` : "";
    await refreshFiles();
    await followConversation(runtime, runtime.root);
    render();
    if (new URLSearchParams(location.search).get("brain") !== "off") await (v5Offline ? startLaptopBrain(runtime) : startBrain(runtime, adopt));
  } catch (error) {
    state.mode = "lost";
    state.banner = `could not open this browser's copy of the run: ${(error as Error).message}`;
    render();
  }
}

// ---- pi on a phone (?phone=1) ------------------------------------------------------------------------------------------
// The whole agent in a phone's page, offline from the start: pi-durable's Harness over this browser's store (SQLite in OPFS, the offline copy's store), the robot's
// tools on a workspace held in the page (files-env.ts: no computer, no Wasmer), the robot pane redrawing from the same files, and a small model in the page
// (D1's robot fine-tune of Qwen3.5-0.8B through wllama, its own tool format, locked to the tools' schemas). A reload finds the conversation and the robot as they
// were. Later the same session connects to the server for the cluster beat; this phase never reaches for the network after the page and the model are cached.

const PHONE_MODEL_ID = V5_MODEL_ID; // the model the phone runs (v5-brain.ts: one implementation for the phone and the laptop)

/**
 * What this phone measured, sent to the page's own server as a GET (/__phone_report?d=<json>) so it lands in the server's access log, where the team reads it:
 * the browser and OS version, the load and ready times, each command's time and tokens (its reply's words only with ?report=text). Same origin, no body, nothing
 * else; ?report=0 turns it off.
 */
function phoneReport(kind: string, data: Record<string, unknown>): void {
  if (new URLSearchParams(location.search).get("report") === "0") return;
  const ios = /OS (\d+)_(\d+)/.exec(navigator.userAgent), safari = /Version\/([\d.]+)/.exec(navigator.userAgent);
  const d = JSON.stringify({ kind, at: Math.round(performance.now()), ios: ios ? `${ios[1]}.${ios[2]}` : null, safari: safari?.[1] ?? null, cores: navigator.hardwareConcurrency ?? null, ...data }).slice(0, 1800);
  fetch(`/__phone_report?d=${encodeURIComponent(d)}`, { keepalive: true, cache: "no-store" }).catch(() => undefined);
}

function phoneSay(phase: string, line?: string): void {
  state.phone ??= { phase: "", ready: false, marks: {}, log: [] };
  state.phone.phase = phase;
  if (phase && !state.phone.ready) setHint(`${phase}…`); // with no header, what the brain is doing shows where you will type
  if (line) state.phone.log.push(`${(performance.now() / 1000).toFixed(1)} s ${line}`);
  render();
}

async function startPhone(): Promise<void> {
  state.mode = "booting";
  phoneSay("opening this phone's copy of the session");
  // what this phone is, in the log a screenshot carries: its browser and OS version, isolation, cores
  const ios = /OS (\d+)_(\d+)/.exec(navigator.userAgent), safari = /Version\/([\d.]+)/.exec(navigator.userAgent);
  state.phone!.log.push(`browser: ${ios ? `iOS ${ios[1]}.${ios[2]}` : "not iOS"}${safari ? `, Safari ${safari[1]}` : ""} · isolated ${globalThis.crossOriginIsolated ? "yes" : "NO"} · cores ${navigator.hardwareConcurrency ?? "?"} · JSPI ${"Suspending" in WebAssembly ? "yes" : "no"} · ${navigator.userAgent}`);
  setHint("the robot's brain is loading…");
  addEventListener("error", (e) => state.phone?.log.push(`page error: ${e.message}`));
  addEventListener("unhandledrejection", (e) => state.phone?.log.push(`unhandled: ${e.reason instanceof Error ? e.reason.message : String(e.reason)}`));
  try {
    const t = performance.now();
    // The store's files are held by one page at a time (OPFS access handles): a page still closing, or another tab of this page, holds them a moment longer. A few
    // tries, then the reason.
    let store: LocalStore | undefined;
    for (let tries = 1; !store; tries++) {
      try {
        store = await openLocalStore(run);
      } catch (e) {
        if (tries >= 5) throw new Error(`opening the session's store (SQLite in OPFS): ${(e as Error).message}. Another tab of this page may hold it: close it and try again.`);
        phoneSay(`the session's store is busy (a page still closing, or another tab): trying again (${tries})`, `store busy: ${(e as Error).message}`);
        await sleepMs(400 * 2 ** tries);
      }
    }
    const storeMs = Math.round(performance.now() - t);
    const fs = memoryFs("/workspace");
    const workspace = new Workspace(fs);
    const restored = await workspace.restore(await loadWorkspace(run)); // none saved is a new session; a saved one that cannot be read stops here, with the retry
    const filesMs = Math.round(performance.now() - t) - storeMs;
    const env = new FilesEnv(fs, "phone");
    const runtime = await startLocal({ storage: store.storage, model: PHONE_MODEL_ID, robotCode: false, computer: { env, workspace }, persist: (changes) => applyChanges(run, changes), deferResume: true }); // resumed once the brain is ready (below)
    Object.assign(state.phone!.marks, { storeMs, filesMs, harnessMs: Math.round(performance.now() - t) - storeMs - filesMs });
    state.runtime = runtime;
    state.mode = "offline";
    state.progress = "";
    phoneSay("the session is open; the robot's brain is loading", `session opened in ${Math.round(performance.now() - t)} ms: store ${storeMs}, files ${filesMs}, harness ${state.phone!.marks.harnessMs} (${restored.files} files restored)`);
    // the conversation this phone was in (New chat starts another; the earlier ones stay in the store)
    const keptId = (() => { try { return localStorage.getItem(`phone-conversation:${run}`); } catch { return null; } })();
    const kept = keptId ? await runtime.harness.conversation(Number(keptId) as never, ctx).catch(() => undefined) : undefined;
    await followConversation(runtime, kept ?? runtime.root);
    await refreshFiles(); // the workspace's files as the session left them (the sheet's tree; later tool calls refresh it)
    $("chat").scrollTop = $("chat").scrollHeight; // a reload opens on the newest lines
    await startPhoneBrain(runtime);
  } catch (error) {
    state.mode = "lost";
    state.banner = `pi could not start on this phone: ${(error as Error).message}`;
    phoneReport("failed", { error: (error as Error).message.slice(0, 600), log: state.phone?.log.slice(-6) });
    render();
  }
}

/** Load the model, make it the conversation's brain with the robot's tools, read the system prompt and the tools once; then the composer opens. */
/** The phone's page and its files in the offline cache, so the next visit opens with no network; said in the log and the report, never in the way. */
async function savePhoneForOffline(modelFiles: string[]): Promise<void> {
  const started = performance.now();
  try {
    await registerOfflineWorker();
    const list = await fetch("/offline.json", { cache: "no-store" }).catch(() => undefined);
    if (!list?.ok) { state.phone?.log.push("no network: the copy saved for offline stays as it is"); return; } // an offline visit runs from that copy
    // the page's build lists the computer's files too (the Wasmer SDK, its package): the phone has no computer, so they are not its to keep
    const shell = ((await list.json()) as { files: string[] }).files.filter((f) => !f.startsWith("/wasmer/") && !f.startsWith("/pkgs/"));
    const creature = await stageFiles(() => fetch("/tab/offline.json", { cache: "no-store" }), "/tab/");
    const saved = await cacheFilesForOffline(["/", ...shell, ...creature, ...modelFiles]);
    state.phone?.log.push(`saved for offline: ${saved.files} files, ${Math.round(saved.bytes / 1e6)} MB in ${((performance.now() - started) / 1000).toFixed(1)} s`);
    phoneReport("offline", { files: saved.files, bytes: saved.bytes, ms: Math.round(performance.now() - started) });
  } catch (e) {
    state.phone?.log.push(`not saved for offline: ${(e as Error).message}`);
    phoneReport("offline", { error: (e as Error).message.slice(0, 300) });
  }
}

/** Set once the phone's brain is ready: starts a fresh conversation (the New chat button). */
let phoneNewChat: (() => Promise<void>) | undefined;

/** Open the phone's composer when its brain is ready; the robot pane after, never during the load (an iPhone ran out of memory with both at once). */
async function startPhoneBrain(runtime: TabRuntime): Promise<void> {
  const params = new URLSearchParams(location.search);
  const marks = state.phone!.marks;
  const brain = await startV5Brain(runtime, {
    params, marks,
    say: phoneSay,
    log: (line) => state.phone!.log.push(line),
    report: (kind, data) => {
      if (kind === "turn-start") state.phone!.turnStarted = performance.now(); // the thinking timer counts from here
      phoneReport(kind, data);
    },
    conversation: () => state.active ?? runtime.root,
    // the phone has nothing else running wasm: wllama's build patches stay as they are
  }, (b) => {
    state.phone!.ready = true;
    state.phone!.model = b.model;
    render(); // the composer opens (canSend reads state.phone.ready)
    setHint("Tell the robot what to do: paint it red, make it a spider, spin…");
    ($("input") as HTMLTextAreaElement).focus();
    // the robot, now that the brain is in: standing still (no physics) until a skill plays
    if (params.get("pane") !== "0") startRobotPane("&still=1");
  });
  // New chat: a fresh conversation on the same brain and tools, followed from now on; the earlier ones stay in the store, and the robot stays as it is
  phoneNewChat = async () => {
    if (state.chat.busy) return;
    const fresh = await brain.newConversation();
    try { localStorage.setItem(`phone-conversation:${run}`, String(fresh.id)); } catch { /* not kept across a reload */ }
    await followConversation(runtime, fresh);
    phoneReport("new-chat", {});
    render();
    ($("input") as HTMLTextAreaElement).focus();
  };
  // and everything a reload needs with no network, behind the service worker: the page, its built assets, the robot pane's, the model's small files (its parts
  // are in wllama's own cache already). ?offline=0 skips it.
  if (params.get("offline") !== "0") void savePhoneForOffline(brain.smallFiles());
}

// ---- coming home ---------------------------------------------------------------------------------------------------------

/** What the page says to the stage around it and to anything listening in the page: a DOM event (`walkshome:<type>`) and, inside a frame, a message to the parent. */
function announce(type: string, detail: Record<string, unknown>): void {
  window.dispatchEvent(new CustomEvent(`walkshome:${type}`, { detail }));
  const message = { source: "walks-home-tab", type, run, ...detail };
  try {
    if (window.parent !== window) window.parent.postMessage(message, stageOrigin ?? location.origin);
  } catch {
    // a parent that is not reachable is not told
  }
  try {
    // A stage that opened this page with window.open names its origin (?stage=<origin>): only that origin is posted to, never "*".
    if (stageOrigin && window.opener) (window.opener as Window).postMessage(message, stageOrigin);
  } catch {
    // an opener that is gone is not told
  }
}

/** The origin of the stage that opened or frames this page (`?stage=<origin>`), when it names one: a messages' only target besides this page's own origin. */
const stageOrigin: string | undefined = (() => {
  const v = new URLSearchParams(location.search).get("stage");
  if (!v) return undefined;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : undefined;
  } catch {
    return undefined;
  }
})();

/** The files of the run's home/ the creature page needs with no network: the policy and the skills (the manifest and each skill's policy), as workspace entries (directories first). */
async function homeFilesForOffline(): Promise<Map<string, { kind: "file"; data: Uint8Array } | { kind: "directory" }>> {
  const out = new Map<string, { kind: "file"; data: Uint8Array } | { kind: "directory" }>();
  const take = async (path: string): Promise<Uint8Array | null> => {
    const bytes = await readWorkFresh(path).catch(() => null);
    if (!bytes) return null;
    for (let i = path.indexOf("/"); i > 0; i = path.indexOf("/", i + 1)) out.set(path.slice(0, i), { kind: "directory" });
    out.set(path, { kind: "file", data: bytes });
    return bytes;
  };
  await take("home/policy.json");
  const manifest = await take("home/skills.json");
  if (manifest) {
    try {
      for (const entry of Object.values(parseSkills(new TextDecoder().decode(manifest)).skills)) await take(skillPolicyPath(entry));
    } catch { /* a manifest the creature page refuses is not followed */ }
  }
  return out;
}

// ---- the robot pane (?robot=1) ---------------------------------------------------------------------------------------------
// The creature page (04 tab, served under /tab/) runs in an iframe and reads and writes its files through this page, which holds the workspace: online and offline alike, so the robot works with
// no network. It reads creature/robot.json (what the agent's robot tools edit), home/skills.json and the skills' policies, and writes the design it saves (creature/*). Reads come from the
// workspace; a file the tab was not sent (home/ is not restored) is fetched from the run's disk while online and was brought into the workspace at the checkout.
const robotMode = new URLSearchParams(location.search).get("robot") === "1";
if (robotMode) setExtraInstructions(ROBOT_SOPS); // the robot demo: the cloud agent also carries the SOPs for writing the robot and planning a teaching run
// scene.json and attempt.json are the flag beat's (04 goal.ts): where the flag stands, and the page's answer to each `do`, which the tool reads back
const CREATURE_WRITABLE = new Set(["creature/designs.sqlite", "creature/creature.xml", "creature/body.json", "creature/design.json", "creature/fit.json", "robot/build.json", "creature/scene.json", "creature/attempt.json"]);
const safePath = (p: unknown): string | undefined => (typeof p === "string" && p.length > 0 && p.length < 200 && !p.startsWith("/") && !p.split("/").some((part) => part === ".." || part === "." || part === "") ? p : undefined);
const diskReads = new Map<string, { at: number; bytes: Uint8Array | null }>();

async function creatureRead(path: string): Promise<Uint8Array | null> {
  const rt = state.runtime;
  if (rt && "sandbox" in rt.env) {
    try { return await (rt.env as WasmerEnv).sandbox.fs.readFile(`/workspace/${path}`); } catch { /* not in the workspace */ }
  }
  // the phone: the workspace's files are the page's own (files-env.ts), nothing is on a disk
  if (rt && rt.env instanceof FilesEnv) return rt.env.fs.readFile(`${rt.env.fs.root}/${path}`).catch(() => null);
  if (state.mode === "offline" || !rt) {
    const saved = (await loadWorkspace(run).catch(() => [])).find((e) => e.path === path && e.kind === "file");
    return saved && saved.kind === "file" ? saved.bytes : null;
  }
  const hit = diskReads.get(path);
  if (hit && Date.now() - hit.at < 3000) return hit.bytes;
  const bytes = await readWork(path).catch(() => null);
  diskReads.set(path, { at: Date.now(), bytes });
  return bytes;
}

/** The creature page's writes: held while a checkout runs (it scans and hands over the workspace, so a write after the scan would be acknowledged and then be missing from the browser's copy), and counted while in flight so the checkout waits for them. */
const creatureGate = new WriteGate(() => state.checkingOut, (ms) => new Promise<void>((r) => setTimeout(r, ms)));

function creatureWrite(path: string, bytes: Uint8Array): Promise<void> {
  return creatureGate.run(async () => {
    const rt = state.runtime;
    // the phone: the workspace's files are the page's own (files-env.ts)
    if (rt && rt.env instanceof FilesEnv) {
      const w = await rt.env.writeFile(path, bytes, ctx);
      if (!w.ok) throw w.error;
      await rt.flush?.(); // durable in this browser's copy before the creature page is told
      return;
    }
    if (!rt || !("sandbox" in rt.env)) throw new Error("not-holder");
    const fs = (rt.env as WasmerEnv).sandbox.fs;
    const dir = path.split("/").slice(0, -1).join("/");
    if (dir) await fs.mkdir(`/workspace/${dir}`, { recursive: true }).catch(() => undefined);
    await fs.writeFile(`/workspace/${path}`, bytes);
    await rt.flush?.(); // durable before the creature page is told: to the pipe online, to this browser's copy offline
  });
}

function startRobotPane(extra = ""): void {
  const frame = $("creature") as HTMLIFrameElement;
  document.body.classList.add("robot");
  setHint("Tell the robot what to do");
  $("creature-pane").hidden = false;
  const reply = (msg: Record<string, unknown>) => frame.contentWindow?.postMessage({ ns: "walks-home", ...msg }, location.origin);
  window.addEventListener("message", (ev) => {
    if (ev.origin !== location.origin || ev.source !== frame.contentWindow) return;
    const m = ev.data as Record<string, unknown> | null;
    if (!m || m.ns !== "walks-home" || typeof m.type !== "string") return;
    if (m.type === "storage-read") {
      const path = safePath(m.path);
      void (path ? creatureRead(path) : Promise.resolve(null)).then(async (bytes) => {
        const etag = bytes ? `${bytes.length}-${await sha256hex(bytes)}`.slice(0, 80) : undefined;
        reply(bytes && etag && m.ifNoneMatch === etag ? { type: "storage-result", id: m.id, bytes: null, notModified: true } : { type: "storage-result", id: m.id, bytes, ...(etag ? { etag } : {}) });
      }, (error: Error) => reply({ type: "storage-result", id: m.id, bytes: null, error: String(error.message ?? error) }));
    } else if (m.type === "storage-write") {
      const path = safePath(m.path);
      if (!path || !CREATURE_WRITABLE.has(path) || !(m.bytes instanceof Uint8Array)) return reply({ type: "storage-written", id: m.id, error: "not-allowed" });
      void creatureWrite(path, m.bytes).then(() => reply({ type: "storage-written", id: m.id }), (error: Error) => reply({ type: "storage-written", id: m.id, error: error.message === "not-holder" ? "not-holder" : String(error.message) }));
    } else if (m.type === "econ-ready") {
      if (creatureQuiet || creatureLow) reply({ type: "set-activity", paused: creatureQuiet, low: creatureLow }); // the creature page is listening now: tell it what it missed
    } else {
      // what the creature page tells the stage (robot-changed, skill-switched, policy-arrived, ...), told on from this page the same way as the page's own events
      const { ns: _ns, type, ...detail } = m;
      announce(type, detail);
    }
  });
  frame.addEventListener("load", () => reply({ type: "set-placement", kind: "tab", label: "this browser" }));
  frame.src = `/tab/?clean=1&banner=1&phase=watch&hero=1&econ=1${robotCodeOn && !phoneMode ? "&legacy=0" : ""}${extra}`; // hero: the robot is the pane's hero (no chrome); econ: it works at a low rate unless something changes it, and stops while the model loads (the browser has one main thread for both)
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The workspace as this browser saved it, in the shape the diff takes (the page's computer did not boot, so there is no live scan). */
async function savedSnapshot(): Promise<Snapshot> {
  const out = new Map<string, { kind: "file"; data: Uint8Array } | { kind: "directory" }>();
  for (const e of await loadWorkspace(run)) if (e.kind === "file") out.set(e.path, { kind: "file", data: e.bytes }); else if (e.kind === "directory") out.set(e.path, { kind: "directory" });
  return out;
}

/**
 * "Go online", from the button or the agent's go_online tool: the run's store and the files written offline go back to the server (checkin.ts, POST /api/runs/<id>/checkin), which takes
 * them only when the store extends what it released at checkout; this tab then attaches as the writer and the SAME conversation is configured onto the cloud model again.
 * The store is exported and kept in OPFS with the changes before anything is sent (`sending`), so what is sent is one fixed thing: a reload in the middle sends the same bytes again (`resumeCheckin`),
 * and a server that already took it answers from its receipt.
 */
async function checkIn(): Promise<void> {
  const runtime = state.runtime, off = state.offline;
  if (state.mode !== "offline" || !runtime || !off || state.checkingIn) return;
  const record = off.record, host = state.brain?.host;
  const started = performance.now();
  const say = (text: string) => { state.checkingIn = { text }; render(); };
  say("waiting for the agent to be idle");
  state.banner = "";
  announce("checkin", { phase: "start", head: record.head });
  let closed = false;
  try {
    if ((await untilIdle(runtime.harness, 30_000)) !== "idle") throw new Error("the agent is answering: wait for the answer, then go online");
    if (!state.net.online) throw new Error(`the server cannot be reached from here yet (${state.net.reason || "no answer to the ping"})`);
    say("saving the workspace in this browser");
    await runtime.flush?.();
    const baseline = await loadBaseline(run);
    if (!baseline) throw new Error("this browser has no record of what the workspace held at checkout, so it cannot say what changed");
    const changes = await diffWorkspace(baseline, off.computer.booted ? ((await runtime.workspace.scan()) as Snapshot) : await savedSnapshot());
    say("closing this browser's copy of the run");
  state.runtime = undefined;
    state.active = undefined;
    await followed?.stop().catch(() => undefined);
    followed = undefined;
    await runtime.close().catch(() => undefined);
    await off.store.storage.close(ctx).catch(() => undefined);
    closed = true;
    const store = await exportStore(run);
    await saveCheckinPayload(run, { store, changes });
    await writeCheckout({ ...record, state: "sending" });
    await sendCheckin(record, { store, changes }, host, started);
  } catch (error) {
    state.checkingIn = undefined;
    if (closed) {
      // nothing was sent, or what was sent was not taken: this browser's copy is whole and stays the live one; open it again, the model still loaded
      await forgetCheckinPayload(run).catch(() => undefined);
      await writeCheckout({ ...record, state: "done" }).catch(() => undefined);
      await startOffline({ ...record, state: "done" }, host);
    }
    announce("checkin", { phase: "failed", message: (error as Error).message });
    state.banner = `could not go online: ${(error as Error).message}`;
    render();
  }
}

/** Send a prepared check-in until the server answers it, then come home: attach as the writer, configure the conversation back onto the cloud model, drop this browser's copy. */
async function sendCheckin(record: CheckoutRecord, payload: { store: Uint8Array; changes: FileChange[] }, host: ModelHost | undefined, started: number): Promise<void> {
  const say = (text: string) => { state.checkingIn = { text }; render(); };
  let done: Awaited<ReturnType<typeof postCheckin>> | undefined;
  try {
    for (let attempt = 1; !done; attempt++) {
      say(attempt === 1 ? `handing ${payload.changes.length} changed file${payload.changes.length === 1 ? "" : "s"} and the store back to the server` : `handing the run back to the server (attempt ${attempt})`);
      try {
        done = await postCheckin({ run, secret, tab, store: payload.store, changes: payload.changes });
      } catch (error) {
        const code = error instanceof CheckinError ? error.code : "";
        // not reached, busy, or a server fault after its check: the same request may be sent again (a server that took it the first time answers from its receipt);
        // a refusal of the store itself never succeeds by repeating
        const again = (code === "NETWORK" || code === "CHECKIN_BUSY" || /^HTTP_5/.test(code)) && attempt < 4;
        if (!again) {
          if (code === "NOT_CHECKED_OUT") throw new Error("the server says this run is not checked out and did not take this store from this tab: this browser keeps its copy, and nothing was deleted; reload this page to see where the run is");
          throw error;
        }
        await sleepMs(1000 * attempt);
      }
    }
  } catch (error) {
    const code = error instanceof CheckinError ? error.code : "";
    if (code === "NETWORK" || code === "CHECKIN_BUSY" || /^HTTP_5/.test(code)) {
      // The server may well have taken it (only its reply was lost): the saved check-in and the `sending` record stay, and this browser's copy is NOT reopened for writes, because a change made now could never
      // match the receipt. The button (or a reload) sends the same bytes again; a server that took it answers from its receipt, one that did not takes it now.
      state.checkingIn = undefined;
      state.pendingCheckin = { record, host };
      state.mode = "lost";
      state.banner = `The server did not confirm the check-in (${(error as Error).message}). This browser keeps it and writes nothing meanwhile; press Go online to send it again.`;
      announce("checkin", { phase: "failed", uncertain: true, message: (error as Error).message, code });
      render();
      return;
    }
    // the server did not take it
    await forgetCheckinPayload(run).catch(() => undefined);
    await writeCheckout({ ...record, state: "done" }).catch(() => undefined);
    state.checkingIn = undefined;
    announce("checkin", { phase: "failed", message: (error as Error).message, ...(error instanceof CheckinError ? { code: error.code } : {}) });
    await startOffline({ ...record, state: "done" }, host);
    state.banner = `could not go online: ${(error as Error).message}`;
    render();
    return;
  }
  // The server has it: from here a reload attaches to the server, and this browser's copy is the server's now.
  try {
    await forgetCheckout(run);
    await forgetCheckinPayload(run).catch(() => undefined);
    state.offline = undefined;
    say("attaching to the server");
    const brain = state.brain;
    state.brain = undefined;
    await connect("write");
    const attached = state.runtime as TabRuntime | undefined; // set by connect() (runHere), which TypeScript cannot see from here
    if ((state.mode as string) !== "writer" || !attached) throw new Error("the run is back on the server but this tab could not attach to it: reload this page");
    // The same conversation, the cloud model again, every tool the registry has again.
    await attached.root.configure(cloudAgent(state.agentModel, { registry: attached.registry, robotCode: robotCodeOn, ...appOption(), ...placed() }), ctx);
    const ms = Math.round(performance.now() - started);
    const event: CheckinEvent = { at: Date.now(), head: done.head, files: done.files, changes: payload.changes.length, ms, offlineHead: record.head };
    await attached.root.submit({ type: "write", requestId: `checkin:${done.head}`, entry: { kind: BRAIN_CHECKIN, data: { head: done.head, files: done.files, changes: payload.changes.length, ms } } }, ctx).catch(() => undefined);
    state.checkingIn = undefined;
    state.checkins.push(event);
    // Online the cloud model answers by default; with ?golive=1 the small model stays loaded for the router, which decides per message who answers (the conversation is configured only when that changes).
    if (brain && golive) await startBrain(attached, brain.host, true);
    else await brain?.dispose();
    await disposeV5();
    void forgetWorkspace(run).catch(() => undefined);
    void deleteStore(run).catch(() => undefined);
    announce("checkin", { phase: "done", ...event });
    render();
  } catch (error) {
    state.checkingIn = undefined;
    announce("checkin", { phase: "failed", message: (error as Error).message });
    state.banner = (error as Error).message;
    render();
  }
}

/** A page opened (or reloaded) while a check-in was on its way: send the saved store and changes again. A server that took them answers from its receipt; one that did not takes them now. */
async function resumeCheckin(record: CheckoutRecord, host?: ModelHost): Promise<void> {
  state.mode = "booting";
  state.progress = "finishing the check-in that was on its way";
  state.checkingIn = { text: "finishing the check-in that was on its way" };
  render();
  announce("checkin", { phase: "start", head: record.head, resumed: true });
  const payload = await loadCheckinPayload(run);
  if (!payload) {
    // nothing to send (the payload is gone): this browser's copy is the run, as it was
    await writeCheckout({ ...record, state: "done" });
    state.checkingIn = undefined;
    return void startOffline({ ...record, state: "done" });
  }
  await sendCheckin(record, payload as { store: Uint8Array; changes: FileChange[] }, host, performance.now());
}

/** The agent's go_offline and go_online tools talk to the page through this: the request is taken now, the move happens once the agent's step is over. */
const offlineChannel: OfflineChannel = {
  async goOffline() {
    if (state.mode !== "writer" || !state.runtime || state.leaving || state.checkingOut || state.switching) throw new OfflineRefusedError("this tab is not running the run right now, so it cannot take it offline");
    if (!state.net.online) throw new OfflineRefusedError("this page cannot reach the server, and the run's store has to be copied from it first");
    if (!golive && !(state.brain?.conversation !== undefined && state.active === state.brain.conversation)) throw new OfflineRefusedError("the model this run trained is not this agent's brain yet");
    if (!(await readManifest(readWork).catch(() => null))) throw new OfflineRefusedError("this run has no model of its own on its disk yet, so there is nothing to run offline");
    setTimeout(() => void takeOffline(), 0);
  },
  async goOnline() {
    if (!golive) throw new OfflineRefusedError("this page was not opened with ?golive=1: here a checkout is for good and the run does not go back");
    if (state.mode !== "offline" || !state.offline || !state.runtime) throw new OfflineRefusedError("this run is not checked out to this browser, so there is nothing to hand back");
    if (state.checkingIn) throw new OfflineRefusedError("a check-in is already in progress");
    if (!state.net.online) throw new OfflineRefusedError(`the server cannot be reached from here yet (${state.net.reason || "no answer to the ping"}); try again when the network is back`);
    setTimeout(() => void checkIn(), 0);
  },
};

/** The page's own view of the network: the browser's signal and, because that signal says only that a link exists, a ping of the server through the service worker (never from its cache). */
async function pingNet(): Promise<void> {
  let online = false, reason = "";
  if (navigator.onLine === false) reason = "the browser says it is offline";
  else {
    try {
      const r = await fetch("/api/ping?fresh=1", { cache: "no-store", signal: AbortSignal.timeout(2500) });
      online = r.ok;
      if (!online) reason = `the ping was answered ${r.status}`;
    } catch (error) {
      reason = `no answer to the ping (${(error as Error).name})`;
    }
  }
  if (online === state.net.online && state.net.at !== 0) { state.net.reason = reason; return renderNet(); }
  state.net = { online, at: Date.now(), reason };
  announce("net", { online, reason });
  render();
}

/** Whether "Take it offline" is possible now (render() works it out with the rest of the writer's state; the ping redraws the toggle without a full render). */
let canTakeOfflineNow = false;

// One toggle for the network: its icon is the state (online, or offline), its tooltip the action it would take.
const WIFI = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 9.5a14 14 0 0 1 19 0"/><path d="M5.8 13a9.4 9.4 0 0 1 12.4 0"/><path d="M9 16.4a4.8 4.8 0 0 1 6 0"/><circle cx="12" cy="19.6" r=".9" fill="currentColor"/></svg>';
const WIFI_OFF = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 9.5a14 14 0 0 1 5-3.1"/><path d="M12 5.5a14 14 0 0 1 9.5 4"/><path d="M5.8 13a9.4 9.4 0 0 1 3.2-2"/><path d="M14.5 10.6a9.4 9.4 0 0 1 3.7 2.4"/><path d="M9 16.4a4.8 4.8 0 0 1 6 0"/><circle cx="12" cy="19.6" r=".9" fill="currentColor"/><path d="M3.5 3.5l17 17"/></svg>';
type Connection = { icon: "online" | "offline"; action: "offline" | "online" | "none"; title: string; busy: boolean };
function connectionState(): Connection {
  const offlineMode = state.mode === "offline";
  const canGoOnline = (offlineMode && golive) || state.pendingCheckin !== undefined;
  const busy = state.checkout !== undefined || state.checkingIn !== undefined;
  if (busy) return { icon: offlineMode || state.checkout ? "offline" : "online", action: "none", title: state.checkout?.text ?? state.checkingIn?.text ?? "", busy: true };
  if (canGoOnline) return { icon: "offline", action: state.net.online ? "online" : "none", title: state.net.online ? "Go online" : "Go online (waiting for the network)", busy: false };
  if (offlineMode) return { icon: "offline", action: "none", title: "Offline: this run is checked out to this browser", busy: false };
  if (!state.net.online) return { icon: "offline", action: "none", title: `Offline: the server cannot be reached (${state.net.reason})`, busy: false }; // before the checkout is offered: taking a run offline copies it from the server
  if (canTakeOfflineNow) return { icon: "online", action: "offline", title: "Take it offline", busy: false };
  return { icon: "online", action: "none", title: "Online", busy: false };
}
function renderNet(): void {
  const c = connectionState();
  const button = $("connection") as HTMLButtonElement;
  button.dataset.state = c.icon;
  button.dataset.action = c.action;
  button.classList.toggle("busy", c.busy);
  button.classList.toggle("inert", c.action === "none");
  button.setAttribute("aria-disabled", String(c.action === "none"));
  button.title = c.title;
  button.setAttribute("aria-label", c.title);
  const icon = c.icon === "online" ? WIFI : WIFI_OFF;
  if (button.dataset.icon !== c.icon) { button.innerHTML = icon; button.dataset.icon = c.icon; }
}

window.addEventListener("online", () => void pingNet());
window.addEventListener("offline", () => void pingNet());
setInterval(() => void pingNet(), 3000);
void pingNet();

/** A check's scripted cloud model, on the runtime that has the cloud provider (every online runtime; offline there is none). */
function installCloud(runtime: TabRuntime | undefined): void {
  if (runtime && state.cloudScript) runtime.models.setProvider(scriptedCloud(state.agentModel, state.cloudScript, state.cloudSeen));
}

// ---- watching ----------------------------------------------------------------------------------------------------------

function applyView(event: Tagged): void {
  const view = untag(event) as ViewEvent | ThreadMsg;
  if (view.kind === "thread") {
    teachThreads.apply(view);
    return;
  }
  if (view.kind === "models") {
    state.modelNames = view.names;
    drawDriver();
    return;
  }
  if (view.kind === "snapshot") {
    state.chat = new ChatView();
    state.chat.apply(view.event);
    state.relayedModel = relayedModel([view.event], null);
  } else {
    noteTools(view.events);
    for (const e of view.events) state.chat.apply(e);
    state.relayedModel = relayedModel(view.events, state.relayedModel);
  }
  drawDriver();
}

/** The agent's switch_environment tool talks to the server over this tab's pipe. */
const switchChannel = new FrameSwitchChannel((frame) => {
  const client = state.client;
  if (!client || client.lost) return false;
  client.send(frame);
  return true;
});

function onFrame(frame: PipeFrame): void {
  if (switchChannel.accept(frame)) return;
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
      state.sent = withoutSent(state.chat.items(), state.sent, frame.requestId);
      state.banner = `not sent: ${frame.message}`;
      break;
    case "placing":
      sentStage(frame.requestId, "deciding", renderChat);
      return;
    case "decision": {
      // Jev answered for a line this page sent: a move shows under the line as the move line will read, before the move's notice is written.
      const probability = frame.decision.options.find((o) => o.id === frame.decision.choice)?.probability;
      const moves = frame.decision.choice !== currentEnv().id;
      if (frame.requestId) sentStage(frame.requestId, "decided", renderChat, moves ? placementLine(envLabel(frame.decision.choice), probability ?? null) : undefined);
      return;
    }
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
    case "submit": {
      // A line the server placed for this run (typed here, in the stage, or by an operator), or its own home turn: this tab runs it. A page that is still taking the run over (it has said `switched`
      // and is not yet the writer) keeps the line and runs it when it is ready: the server's home turn comes about 15 ms after `switched`, and was dropped here when the page's last read of its
      // conversation was slower than that (a slow link, a loaded laptop): no home turn, a 60 s wait, then the user's lines behind it. Only a page that is not taking a run over drops it.
      const phase: GatePhase = state.runtime && state.mode === "writer" ? "ready" : state.mode === "booting" || state.mode === "connecting" ? "starting" : "gone";
      if (submitGate.offer(frame, phase) === "held") announce("submit-held", { requestId: frame.requestId, mode: state.mode });
      return;
    }
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
    // After the swap the agent's brain is in this tab: the move is said in the chat, where the viewers read it (brain.ts noteMove).
    if (state.brain?.conversation && state.active === state.brain.conversation) {
      const to = state.placement?.where === "moving" ? state.placement.to : "the next host";
      await state.brain.noteMove(switchId, to).catch(() => undefined);
    }
    // Every write-through is acknowledged before its tool result commits: what the disk has from this tab.
    state.left = { switchId, digest: await runtime.workspace.baselineDigest(), step: how };
    state.progress = how === "idle" ? "the agent was idle; handing over" : how === "step" ? "step finished; handing over" : "step still running; handing over (the next host resumes it)";
    render();
  state.runtime = undefined;
    state.active = undefined;
    const brain = state.brain;
    state.brain = undefined;
    await followed?.stop().catch(() => undefined);
    followed = undefined;
    await runtime.close().catch(() => undefined);
    await brain?.dispose(); // the model's workers go with the run: coming back builds a new host, not another copy beside this one
  }
  state.client?.send({ t: "drained", switchId, ...(state.left?.switchId === switchId ? { acked: state.left.digest } : {}) });
}

/** A fresh snapshot of this tab's conversation for the viewers (a viewer just joined). */
async function sendSnapshot(): Promise<void> {
  const runtime = state.runtime;
  if (!runtime || state.mode !== "writer") return;
  const conversation = target()!;
  const stream = await watchEvents(runtime.harness, conversation.id, ctx);
  const front = conversation.id === runtime.root.id ? [] : (await watchEvents(runtime.harness, runtime.root.id, ctx).then(async (w) => { const e = w.snapshot.entries; await w.stop(); return e; }));
  state.client?.view({ kind: "snapshot", ...(conversation.id === runtime.root.id ? {} : { root: false as const }), event: front.length ? { ...stream.snapshot, entries: [...front, ...stream.snapshot.entries] } : stream.snapshot } satisfies ViewEvent);
  await stream.stop();
}

const fileRow = (f: FileEntry): FileRow => (f.kind === "file" ? { path: f.path, kind: "file", size: Math.floor((f.data.length * 3) / 4), data: f.data } : { path: f.path, kind: f.kind, size: 0 });

/** Opening the link runs the agent here once, when nothing runs it; a run held elsewhere is only watched. */
let offeredToRun = false;

function watching(viewing: Viewing): void {
  if (viewing.placement.where === "checked-out") {
    // The pipe says the run is checked out. If this browser holds the copy (its record), the run is here; else it is somewhere else, and nothing here can run it.
    void readCheckout(run).then(async (record) => {
      if (record) {
        const done = { ...record, state: "done" as const };
        await writeCheckout(done);
        await startOffline(done);
      }
    });
  }
  state.mode = "viewer";
  state.progress = "";
  state.leaving = undefined;
  state.environments = viewing.environments;
  if (viewing.model) state.agentModel = viewing.model;
  state.placement = viewing.placement;
  state.files = viewing.files.map(fileRow);
  state.chat = new ChatView();
  state.sent = [];
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
  submitGate.discard(); // a line held for an earlier attach is not run by this one
  if (mode === "write") submitGate.begin(); // everything the server sends until this page is the writer and ready waits its turn, in order
  state.client?.close();
  state.client = undefined;
  if (mode === "write") {
    // The computer boots before the tab asks for the run: the pipe holds a claim only for a tab that can use it.
    state.mode = "booting";
    render();
    try {
      await ensureComputer();
    } catch (error) {
      // The computer's package could not be loaded (a server without it answers 404): say what, in the banner, instead of leaving the boot progress up.
      state.mode = "lost";
      state.banner = `could not start the computer: ${(error as Error).message}`;
      render();
      return;
    }
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
  submitGate.discard();
  if (state.checkingOut) {
    // The pipe closing this socket after the handover was asked is the handover. Before that it is an ordinary loss: kept, so the checkout stops and the loss is handled when it does.
    if (!state.handoverAsked) state.savedLoss = { client, code, message };
    return;
  }
  const wasWriter = state.mode === "writer" || state.mode === "booting";
  await state.runtime?.close().catch(() => undefined);
  state.runtime = undefined;
  state.active = undefined;
  state.brainPending = false;
  const brain = state.brain;
  state.brain = undefined;
  await brain?.dispose(); // connection lost or the run moved: release the model
  if (state.leaving && code === "RELEASED") {
    // This tab handed the run over: watch where it went.
    state.mode = "connecting";
    render();
    void connect("view");
    return;
  }
  state.mode = "lost";
  state.banner =
    code === "CHECKED_OUT" ? "This run is checked out to a browser: its live copy is there, and nothing here runs it any more." :
    code === "MOVED" ? "This run moved to another device. This tab stopped; it wrote nothing after the move." :
    code === "FENCED" ? "Another host took the run's disk. This tab stopped; its writes after that were refused." :
    code === "RELEASED" ? "The run was handed to the cloud." :
    code === "CLOSED" ? "The connection to the disk closed." : message;
  render();
  // Keep watching from here, read-only.
  if (wasWriter || code !== "CLOSED") setTimeout(() => void connect("view"), 800);
}

/** A sent line moves to its next stage (and, once Jev decided, shows the move). Unknown lines (another page's) are ignored. */
function sentStage(requestId: string, stage: Sent["stage"], draw: () => void, move?: string): void {
  const line = state.sent.find((s) => s.requestId === requestId);
  if (!line || line.stage === stage && line.move === move) return;
  line.stage = stage;
  if (move !== undefined) line.move = move;
  draw();
}

function send(): void {
  const input = $("input") as HTMLTextAreaElement;
  const text = input.value.trim();
  if (!text) return;
  // Held: a checkout is deciding where the run lives, or the saved conversation is still coming back. A page attached to a placing server sends its line to the server (it places the run, then the line comes back here or goes to the VM); one that cannot reach it runs the line itself.
  const route = composerRoute({ held: !!(state.checkingOut || state.checkingIn || state.brainPending || state.rehoming), running: !!state.runtime, mode: state.mode, online: state.net.online, placed: state.placed, ...(state.placement ? { watching: state.placement.where } : {}) });
  if (route === "ignore") return;
  input.value = "";
  const requestId = `ui-${crypto.randomUUID()}`;
  state.sent.push({ requestId, text, base: sentBase(state.chat.items(), state.sent, text), stage: "sending" }); // the line shows the moment it is sent, not when the transcript has it
  if (route === "server") {
    state.client?.send({ t: "submit", text, requestId });
    renderChat();
    return;
  }
  renderChat();
  sendLine = sendLine.then(() => decideAndSubmit(text, requestId)).catch((error: Error) => {
    state.sent = withoutSent(state.chat.items(), state.sent, requestId);
    state.banner = `not sent: ${error.message}`;
    render();
  });
}

/** One message at a time through the router, in the order they were typed. */
let sendLine: Promise<void> = Promise.resolve();

/** The brain router's question goes to the server, which holds Jev's key (brainJudgeRoute); a server that cannot be asked makes the router answer the cloud. */
const remoteJudge: JudgeRunner = async (params) => {
  const r = await fetch(`/api/runs/${encodeURIComponent(run)}/brain-judge`, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify({ label: params.label, state: params.state, questions: params.questions }), ...(params.signal ? { signal: params.signal } : {}) });
  if (!r.ok) throw new Error(`the server answered ${r.status}`);
  return (await r.json()) as Awaited<ReturnType<JudgeRunner>>;
};
const router = brainRouter({ runJudge: remoteJudge, ...(Number(new URLSearchParams(location.search).get("routems")) > 0 ? { timeoutMs: Number(new URLSearchParams(location.search).get("routems")) } : {}) });

/**
 * A message from this page. With ?golive=1 it first goes through the brain router: offline, the rule (the model in this tab, no call); online with the trained model loaded, Jev on the server;
 * online without it, the cloud. The brain it picks becomes the conversation's model (`Brain.use`, only when it changes), the decision is written in the conversation and told to the stage
 * (`walkshome:brain`), and then the message is submitted to the one conversation.
 */
async function decideAndSubmit(text: string, requestId = `ui-${crypto.randomUUID()}`): Promise<void> {
  const runtime = state.runtime, conversation = target();
  if (!runtime || !conversation) return;
  if (golive && (state.mode === "writer" || state.mode === "offline")) {
    sentStage(requestId, "deciding", renderChat);
    const brain = state.brain;
    const ready = brain !== undefined && brain.modelId !== undefined && brain.host.state().phase === "answered";
    const decision = await router.decide(text, { online: state.mode === "writer" && state.net.online, localModel: ready ? { id: brain!.modelId! } : null });
    if (ready) await brain!.use(decision.brain, cloudAgent(state.agentModel, { registry: state.runtime!.registry, robotCode: robotCodeOn, ...appOption(), ...placed() }));
    const event = brainEvent(decision, { local: "the model in this tab", cloud: "the cloud model" });
    state.decisions.push(event);
    announce("brain", event);
    await runtime.root.submit({ type: "write", requestId: `decision:${requestId}`, entry: { kind: BRAIN_DECISION, data: event } }, ctx).catch(() => undefined);
  }
  await conversation.submit({ type: "input", content: text, requestId }, ctx);
}

$("send").addEventListener("click", send);
$("ws-toggle").addEventListener("click", () => document.body.classList.toggle("ws-open"));
$("ws-close").addEventListener("click", () => document.body.classList.remove("ws-open"));
// the phone's Files button (its header is hidden), and a tap outside the sheet (on the shade behind it, which is the body's) closes it
$("phone-files").addEventListener("click", () => { (document.activeElement as HTMLElement | null)?.blur?.(); document.body.classList.toggle("ws-open"); }); // the keyboard goes down: the sheet gets the screen
document.body.addEventListener("click", (e) => { if (e.target === document.body && document.body.classList.contains("phone")) document.body.classList.remove("ws-open"); });
$("input").addEventListener("keydown", (e) => {
  if ((e as KeyboardEvent).key === "Enter" && !(e as KeyboardEvent).shiftKey) {
    e.preventDefault();
    send();
  }
});
$("takeover").addEventListener("click", () => void connect("write", true));
$("connection").addEventListener("click", () => {
  const action = ($("connection") as HTMLButtonElement).dataset.action;
  if (action === "offline") return void takeOffline();
  if (action !== "online") return;
  const pending = state.pendingCheckin;
  if (pending) {
    state.pendingCheckin = undefined;
    state.banner = "";
    void resumeCheckin(pending.record, pending.host);
  } else void checkIn();
});
// The operator's fallbacks (move it by hand, bring it home) are behind the Running-in label, not in the bar: the agent and Jev move it by themselves.
function closeMenu(): void {
  $("where-menu").hidden = true;
  $("badge-text").setAttribute("aria-expanded", "false");
}
$("badge-text").addEventListener("click", () => {
  if (!$("badge-text").classList.contains("has-menu")) return;
  const open = $("where-menu").hidden;
  $("where-menu").hidden = !open;
  $("badge-text").setAttribute("aria-expanded", String(open));
});
$("where-menu").addEventListener("click", (e) => { if ((e.target as HTMLElement).closest("button")) closeMenu(); });
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || $("where-menu").hidden) return;
  closeMenu();
  $("badge-text").focus(); // the keyboard user keeps their place (a click outside does not steal focus)
});
document.addEventListener("click", (e) => { if (!$("badge").contains(e.target as Node)) closeMenu(); });
$("cannot").replaceChildren(...CANNOT_OFFLINE.map((line) => el("li", {}, line)));
// ?phone=1, after a start that failed: try again, or forget the cached model files first
$("retry").addEventListener("click", () => location.reload());
$("new-chat").addEventListener("click", () => void phoneNewChat?.().catch((e: Error) => { state.banner = `could not start a new chat: ${e.message}`; render(); }));
$("retry-clear").addEventListener("click", () => { const u = new URL(location.href); u.searchParams.set("clearcache", "1"); location.href = u.href; });
setInterval(renderStats, 1000);

/** Opening the page: a run checked out to this browser runs from OPFS, whatever the network; otherwise the link attaches to the pipe. */
async function boot(): Promise<void> {
  const record = run ? await readCheckout(run).catch(() => undefined) : undefined;
  if (record?.state === "done") return void startOffline(record);
  if (record?.state === "sending") return void resumeCheckin(record);
  if (record?.state === "copied" && secret) {
    // A checkout that was not seen to the end: ask again. The pipe answers a handover it made as the first time; a refusal means nothing was handed over.
    const outcome = await confirmHandover(() => requestCheckout({ run, secret, tab: record.tab, head: record.head, conversation: record.conversation }), { tries: 3 });
    if (outcome.state === "done") {
      const done = { ...record, state: "done" as const };
      await writeCheckout(done);
      return void startOffline(done);
    }
    if (outcome.state === "unknown") {
      state.mode = "lost";
      state.banner = "A handover of this run to this browser was started and the server cannot be reached to learn how it ended. This browser keeps its complete copy; reload when the server can be reached.";
      render();
      return;
    }
    await forgetCheckout(run); // the server refused: it did not hand the run over, so the copy is stale
  }
  if (!run || !secret) {
    $("badge-text").textContent = "No run";
    $("badge").title = "Open a run's link: /run/<id>#<secret>";
    return;
  }
  void connect("view");
}
// The phone starts the robot pane once its brain is ready (startPhoneBrain): loading the model and the pane's physics and 3D together is what a phone's memory
// and main thread cannot afford. ?pane=0 (a measurement): no pane at all.
if (robotMode) startRobotPane();
if (phoneMode) {
  document.body.classList.add("phone");
  if (new URLSearchParams(location.search).get("debug") === "1") document.body.classList.add("debug");
  // The page is the visual viewport: its height (the keyboard takes the rest) and where it is (iOS pans it when the keyboard opens), so the composer sits
  // right above the keyboard and the conversation scrolls under it.
  const vv = window.visualViewport;
  const fit = () => {
    const h = Math.round(vv?.height ?? innerHeight);
    document.documentElement.style.setProperty("--vvh", `${h}px`);
    document.body.style.top = `${Math.round(vv?.offsetTop ?? 0)}px`;
    document.body.classList.toggle("typing", h < innerHeight * 0.8 || document.activeElement === $("input"));
    const chat = $("chat");
    if (chat.scrollHeight - chat.scrollTop - chat.clientHeight < 120) chat.scrollTop = chat.scrollHeight; // a reader at the end stays at the end
  };
  vv?.addEventListener("resize", fit);
  vv?.addEventListener("scroll", fit);
  addEventListener("resize", fit);
  $("input").addEventListener("focus", () => requestAnimationFrame(() => { fit(); $("chat").scrollTop = $("chat").scrollHeight; })); // typing: the newest lines in view
  $("input").addEventListener("blur", () => requestAnimationFrame(fit));
  fit();
}
void (phoneMode ? startPhone() : boot());

// For the recording script: what the page shows, in one object.
(globalThis as { demo?: unknown }).demo = {
  state,
  items: () => state.chat.items(),
  /** Redraw the chat now (a check redraws while a tool result is open). */
  renderChat: () => renderChat(),
  /** A relayed view event as a watching page receives it (a check feeds one: the snapshot, the events, the host's model names). */
  view: (event: unknown) => { applyView(tag(event)); render(); },
  /** Redraw the page's header and controls now (a check sets a placement and looks at the bar). */
  render: () => render(),
  /** Set the composer's hint, as the page does (checks set a long one). */
  hint: (text: string) => setHint(text),
  /** Open a workspace file in the panel, as a click on the tree does. */
  select: (path: string) => select(path),
  /** A teaching thread's message, as the host relays it (checks fold one in). */
  thread: (msg: ThreadMsg) => { teachThreads.apply(msg); renderChat(); },
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
  /** The brain swap, for checks: the model's phase, whether the chat input goes to the trained model's conversation, and what the page says. */
  /** The laptop's offline brain (v5): its prefetch, whether it can answer, what it measured and logged. */
  v5: () => ({ prefetch: state.v5.prefetch, prefetchText: state.v5.prefetchText, ready: state.v5.ready, build: state.v5.brain?.build ?? null, marks: { ...state.v5.marks }, log: [...state.v5.log], turns: state.v5.brain?.model.turns.length ?? 0, warmPrompt: state.v5.brain?.model.warmPrompt?.length ?? 0 }),
  brain: () => ({ phase: state.brain?.host.state().phase ?? null, swapped: state.brain?.conversation !== undefined && state.active === state.brain.conversation, conversation: state.active ? String(state.active.id) : null, status: state.brainStatus }),
  /** A probe (scratch): one raw completion of the first window for `task`, with the call grammar engaged lazily on "<tool_call>" (`lazy`) or as a plain grammar after it. */
  probe: async (task: string, variant: "lazy-with-trigger" | "lazy-without-trigger" | "none") => {
    const base = renderPrompt(TOOLS, [{ role: "user", content: task }]) + "<thinking>";
    const g = callGrammar();
    const grammar = variant === "lazy-with-trigger" ? g.replace("root ::= ", 'root ::= "<tool_call>" ') : g;
    const extra = variant === "none" ? undefined : { grammar_lazy: true, grammar_triggers: [{ type: 1, value: "<tool_call>" }] };
    const started = performance.now();
    const r = await state.brain!.host.withBackend((b) => b.complete({ prompt: base, maxTokens: 400, ...(variant === "none" ? {} : { grammar, ...(extra ? { extra } : {}) }) }));
    return { ms: Math.round(performance.now() - started), text: r.text, stoppedBy: r.stoppedBy, out: r.outputTokens, timings: r.timings };
  },
  /** The workspace as this browser has saved it (OPFS), for checks: path, kind and the text of each file. */
  saved: async () => (await loadWorkspace(run)).map((e) => ({ path: e.path, kind: e.kind, text: e.kind === "file" ? new TextDecoder().decode(e.bytes).slice(0, 400) : null })),
  /** The tool turns of the trained model so far (?configure=1). */
  toolTurns: () => state.toolTurns,
  homecomings: () => state.homecomings,
  /** The brain's current identity (the active adapter's sha256, or the merged model's) and how many times a later homecoming replaced the model. */
  brainId: () => (state.brain ? { id: state.brain.currentId ?? null, modelId: state.brain.modelId ?? null, rehomes: state.brain.rehomes } : null),
  /** The computer while checked out: whether it booted from the cache, how long that took, how many files came back from OPFS, why not. */
  computer: () => state.offline?.computer ?? null,
  /** Run a shell command on the page's computer (a check; the agent's own tools run through the Harness). */
  exec: async (command: string) => {
    const env = state.runtime?.env as WasmerEnv | undefined;
    if (!env || !("sandbox" in env)) return { error: "no computer" };
    let output = "";
    const started = performance.now();
    const r = await env.exec(command, { timeout: 60, onOutput: (text) => { output += text; } }, ctx);
    return r.ok ? { exitCode: r.value.exitCode, output, ms: Math.round(performance.now() - started) } : { error: r.error.message, output };
  },
  /** Make the workspace's changes durable in this browser's copy now. */
  flush: async () => { await state.runtime?.flush?.(); },
  /** Write a file in the workspace and make it durable in this browser's copy now. */
  writeFile: async (path: string, text: string) => {
    const env = state.runtime?.env as WasmerEnv | undefined;
    if (!env || !("sandbox" in env)) return false;
    await env.sandbox.fs.writeFile(`/workspace/${path}`, text);
    await state.runtime!.flush?.();
    return true;
  },
  /** The tasks the Harness has, with their state (what is running, what failed), for checks. */
  tasks: async () => (state.runtime ? (await state.runtime.harness.inspect(ctx)).tasks.map((t) => ({ kind: t.record.kind, state: t.state.kind })) : null),
  /** The run checked out to this browser: the record, the head of the local store, whether the page is cross-origin isolated, and the page's own words. */
  offline: async () => ({
    mode: state.mode,
    record: state.offline?.record ?? null,
    head: state.offline ? await state.offline.store.head() : null,
    isolated: globalThis.crossOriginIsolated,
    checkout: state.checkout?.text ?? null,
    banner: state.banner,
    panel: { hidden: ($("checkedout") as HTMLElement).hidden, text: $("checkedout").textContent },
  }),
  /** The entries of the conversation the chat input goes to, oldest first: kind, and the message text. */
  activeEntries: async () => {
    const c = target();
    if (!c) return null;
    return [...(await c.entries({}, 500, undefined, ctx)).items].reverse().map((e) => ({ id: String(e.id), kind: e.kind, role: ((e as unknown as { model?: { role: string }[] }).model ?? [])[0]?.role }));
  },
  /** The active conversation's entries as the store has them (JSON-safe), newest last, for a recording or a spec. */
  rawEntries: async () => {
    const c = target();
    return c ? JSON.parse(JSON.stringify([...(await c.entries({}, 500, undefined, ctx)).items].reverse())) : null;
  },
  /** Whether this page reaches the server (the browser's signal and a ping), and when that last changed. */
  net: () => ({ ...state.net }),
  /** Every check-in this page made: the head the server holds after it, the files written offline, the changes sent, how long it took. */
  checkins: () => state.checkins,
  /** The same paths the agent's tools take (and the page's buttons): hand the run to this browser, hand it back. */
  goOffline: () => offlineChannel.goOffline().then(() => "asked", (e: Error) => e.message),
  goOnline: () => offlineChannel.goOnline().then(() => "asked", (e: Error) => e.message),
  /** The conversation the agent runs: its model, the tools a request offers (names, in order) and its instructions. */
  agent: async () => {
    const c = state.runtime?.root;
    if (!c) return null;
    const a = await c.agent(ctx);
    return { model: a.model ? `${a.model.provider}/${a.model.modelId}` : null, tools: a.tools.map((t) => t.name), instructions: (a.instructions ?? "").slice(0, 120) };
  },
  /** ?phone=1: the brain's phase and marks, every turn it took (time, tokens, calls), the engine's lines, and the workspace's files as the page holds them. */
  phone: () => (state.phone ? { phase: state.phone.phase, ready: state.phone.ready, marks: state.phone.marks, turns: state.phone.model?.turns.map(({ prompt: _p, ...t }) => t) ?? [], log: state.phone.log.slice(-40), files: state.runtime?.env instanceof FilesEnv ? [...(state.runtime.env.fs as ReturnType<typeof memoryFs>).nodes.keys()] : [] } : null),
  /** ?phone=1: the prompt of the last turn (to check that the warm-up's prefix is the turns' prefix). */
  phonePrompts: () => ({ warm: state.phone?.model?.warmPrompt ?? null, turns: state.phone?.model?.turns.map((t) => t.prompt) ?? [] }),
  /** The routing decisions so far (stage events), and how many times the conversation was configured to the other brain since the router's brain was started. */
  decisions: () => state.decisions,
  brainSwitches: () => state.brain?.switches ?? null,
  /** A scripted stand-in for the cloud model (a check with no cloud): one turn per request, text or a tool call. Kept across check-ins, and what each request carried is `cloudSeen`. */
  stubCloud: (script: ScriptedTurn[]) => { state.cloudScript = script; state.cloudSeen.length = 0; installCloud(state.runtime); return true; },
  cloudSeen: () => state.cloudSeen,
  handovers: () => state.handovers,
  left: () => state.left,
  switchTo,
  timings: () => state.client && { commit: state.client.timings.commit, files: state.client.timings.files, rtts: state.client.rtts, computerMs: state.computerMs, bootMs: state.bootMs, syncs: state.runtime?.syncs },
};

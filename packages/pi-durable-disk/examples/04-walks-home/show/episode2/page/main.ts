// Episode 2's stage ("It Comes Home Obsessed"): the same header and cloud-disk line as Walks Home, a training panel while the agent is away, the tab
// at home, the agent's chat on the right, one caption at a time in plain words. Served at /ep2/. It reuses Walks Home's pure modules unchanged.
// What it knows about training it reads from work/train/progress.jsonl on the run's disk (episode2/progress.ts); what it knows about the model it
// reads from the tab's own messages (episode2/notes.ts). It computes no number of its own.
import { badgeFor, MEMORY_LINE, trackFor } from "../../page/badge.ts";
import { CaptionDesk } from "../../page/caption.ts";
import { syncChat } from "../../page/chat.ts";
import { $, esc } from "../../page/dom.ts";
import { Feed } from "../../page/feed.ts";
import { TabBridge } from "../../page/shell.ts";
import { plainSwitch, visibleTag } from "../../page/story-notes.ts";
import type { Note, ShowState, TabToShell } from "../../types.ts";
import { isChatIn, ModelChat } from "../model-chat.ts";
import { EpisodeNotes, foldModel, initialModel, isModelEvent, modelBanner, tripNote, type ModelEvent } from "../notes.ts";
import { panelHtml } from "../panel.ts";
import { emptyTrain, parseProgress, type Train } from "../progress.ts";
import { dueScriptedModel, scriptedAnswer, scriptedDeltas } from "../rehearsal.ts";
import { SerialReader } from "../reader.ts";

const params = new URLSearchParams(location.search);
const debug = params.get("debug") === "1";
$<HTMLIFrameElement>("tab").src = "/tab/?clean=1&banner=1&episode=2";

const feed = new Feed();
const bridge = new TabBridge($<HTMLIFrameElement>("tab"));
const desk = new CaptionDesk();
const said = new EpisodeNotes();
const modelChat = new ModelChat();

/** Everything the page remembers about the take on screen. It all starts over when the feed does (a retake, a reset). */
const take = { generation: -1, notes: [] as Note[], train: emptyTrain() as Train, progressText: "", model: initialModel(), homeAt: null as number | null, scriptedSent: 0, realModelSeen: false, chatEmptySeen: false, requestAt: null as number | null };
function syncTake(): void {
  if (take.generation === feed.generation) return;
  const first = take.generation === -1;
  take.generation = feed.generation;
  if (first) return;
  Object.assign(take, { notes: [], train: emptyTrain(), progressText: "", model: initialModel(), homeAt: null, scriptedSent: 0, realModelSeen: false, chatEmptySeen: false, requestAt: null });
  said.reset();
  modelChat.reset();
}
function addNotes(...notes: Note[]): void {
  syncTake();
  take.notes.push(...notes);
  if (take.notes.length > 200) take.notes.splice(0, take.notes.length - 200);
}

/** The tab keeps its files on the run's disk through this page. */
async function answerStorage(m: Extract<TabToShell, { type: "storage-read" | "storage-write" }>): Promise<void> {
  const url = `/api/disk/${m.path.split("/").map(encodeURIComponent).join("/")}`;
  const why = async (res: Response) => ((await res.json().catch(() => undefined)) as { error?: string } | undefined)?.error ?? `HTTP ${res.status}`;
  try {
    if (m.type === "storage-read") {
      const res = await fetch(url, { cache: "no-store", headers: m.ifNoneMatch ? { "if-none-match": m.ifNoneMatch } : {} });
      if (res.status === 304) return bridge.send({ type: "storage-result", id: m.id, bytes: null, notModified: true, etag: res.headers.get("etag") ?? m.ifNoneMatch });
      if (res.status === 204 || res.status === 404) return bridge.send({ type: "storage-result", id: m.id, bytes: null });
      if (!res.ok) throw new Error(await why(res));
      const etag = res.headers.get("etag");
      return bridge.send({ type: "storage-result", id: m.id, bytes: new Uint8Array(await res.arrayBuffer()), ...(etag ? { etag } : {}) });
    }
    const res = await fetch(url, { method: "PUT", body: m.bytes as BodyInit });
    if (res.status === 409) return bridge.send({ type: "storage-written", id: m.id, error: "not-holder" });
    if (!res.ok) throw new Error(await why(res));
    bridge.send({ type: "storage-written", id: m.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (m.type === "storage-read") bridge.send({ type: "storage-result", id: m.id, bytes: null, error: message });
    else bridge.send({ type: "storage-written", id: m.id, error: message });
  }
}

/** `scripted`: the rehearsal's own stand-in for the tab. Its notes never carry the tab's origin, so no invented number reads as measured. */
function onModel(m: ModelEvent, scripted = false): void {
  syncTake();
  take.model = foldModel(take.model, m);
  addNotes(...said.fromModel(m, feed.captionNow(), { scripted }));
  // The whole trip, once, at the end: from the viewer's request to the model answering (the chat switching), on the feed's own clock.
  if (m.type === "model-switched" && said.once("trip")) {
    const trip = tripNote(take.requestAt, feed.captionNow(), feed.captionNow());
    if (trip) addNotes(trip);
  }
}
bridge.onMessage((m: TabToShell) => {
  if (m.type === "storage-read" || m.type === "storage-write") return void answerStorage(m);
  syncTake();
  if (isModelEvent(m)) {
    take.realModelSeen = true;
    onModel(m);
  }
  // The tab's answers, already judged there: shown exactly as received.
  if (isChatIn(m)) modelChat.handle(m);
});

// The training progress file, read about once a second, one read at a time, each tied to the take it was asked in (episode2/reader.ts). 204 (not
// written yet) and a failed read are both "nothing new": the panel keeps what it has.
const progressReader = new SerialReader(
  async () => {
    const res = await fetch("/api/disk/train/progress.jsonl", { cache: "no-store" });
    return res.status === 200 ? await res.text() : undefined;
  },
  () => feed.generation,
  (text) => {
    syncTake();
    if (text === take.progressText) return;
    take.progressText = text;
    take.train = parseProgress(text);
    addNotes(...said.fromTrain(take.train, feed.captionNow()));
  },
);
setInterval(() => void progressReader.tick(), 1000);

function withNotes(state: ShowState): ShowState {
  const feedNotes = debug ? state.notes : state.notes.map(plainSwitch);
  return take.notes.length === 0 && feedNotes === state.notes ? state : { ...state, notes: [...feedNotes, ...take.notes].sort((a, b) => a.at - b.at) };
}

let badgeKey = "";
function renderBadge(state: ShowState): void {
  const b = badgeFor(state);
  const el = $("badge");
  el.dataset.tone = b.tone;
  el.querySelector(".txt")!.textContent = b.text;
  const memoryEl = el.querySelector<HTMLElement>(".memory")!;
  memoryEl.hidden = !b.memory;
  if (b.memory) memoryEl.textContent = MEMORY_LINE;
  const track = trackFor(state);
  el.dataset.at = track.at;
  const right = el.querySelector<HTMLElement>(".node.b")!;
  right.hidden = track.right === null;
  right.textContent = track.right ?? "";
  if (b.text !== badgeKey) {
    if (badgeKey !== "") {
      el.classList.remove("swap");
      void el.offsetWidth;
      el.classList.add("swap");
    }
    badgeKey = b.text;
  }
}

let panelKey = "";
function renderPanel(state: ShowState): void {
  const away = state.place.where === "moving" || state.place.where === "cloud" || state.place.where === "universes";
  const el = $("train");
  el.classList.toggle("off", !away);
  const html = panelHtml(take.train);
  if (html !== panelKey) {
    panelKey = html;
    el.innerHTML = html;
  }
}

let bannerKey = "";
function renderBanner(): void {
  const text = modelBanner(take.model);
  const key = `${take.model.phase}|${text}`;
  if (key === bannerKey) return;
  bannerKey = key;
  const el = $("modelbanner");
  el.hidden = text === null;
  el.dataset.phase = take.model.phase;
  el.textContent = text ?? "";
}

/** A rehearsal has no tab that loads a model: from the moment the run is home the page plays the tab's messages, scripted (episode2/rehearsal.ts). */
function playRehearsalModel(state: ShowState): void {
  if (state.source !== "scripted" || take.realModelSeen) return;
  const now = feed.captionNow();
  if (state.place.where === "home" && state.stays.some((s) => s.hostKind !== "tab")) take.homeAt ??= now;
  if (take.homeAt === null) return;
  for (const m of dueScriptedModel(take.homeAt, now, take.scriptedSent)) {
    take.scriptedSent++;
    onModel(m, true);
  }
}

let shownCaption = "";
function renderCaption(state: ShowState): void {
  const c = desk.update(withNotes(state), feed.captionNow());
  const key = c ? `${c.at}|${c.tag}|${c.text}` : "";
  if (key === shownCaption) return;
  shownCaption = key;
  const el = $("vcaption");
  el.hidden = c === null;
  const tag = c ? visibleTag(c.tag, debug) : null;
  el.dataset.tag = c?.tag ?? "";
  el.innerHTML = c ? `${tag ? `<span class="tag ${tag}">${tag}</span>` : ""}<span class="txt">${esc(c.text)}</span>` : "";
}

/** When the viewer's request was first seen, on the feed's clock: only by a page that saw the chat without it (one that joined mid-take claims no total). */
function noteRequest(state: ShowState): void {
  const asked = state.chat.some((t) => t.role === "user");
  if (!asked) take.chatEmptySeen = true;
  else if (take.requestAt === null && take.chatEmptySeen) take.requestAt = feed.captionNow();
}

function frame(): void {
  syncTake();
  const state = feed.state;
  noteRequest(state);
  $("lost").hidden = !feed.lost;
  playRehearsalModel(state);
  renderBadge(state);
  renderPanel(state);
  renderBanner();
  const turns = [...state.chat, ...modelChat.turns];
  syncChat($("chatlog"), turns);
  // The model's turns say who is speaking.
  for (const el of Array.from($("chatlog").children) as HTMLElement[]) {
    const model = /^m\d/.test(el.dataset.id ?? "");
    el.classList.toggle("model", model);
    const who = el.querySelector(".who");
    if (model && who && who.textContent !== "The model") who.textContent = "The model";
  }
  const talkingToModel = take.model.phase === "switched";
  const input = $<HTMLInputElement>("chatin");
  const placeholder = talkingToModel ? "Ask the model anything" : "Tell the agent what to do";
  if (input.placeholder !== placeholder) input.placeholder = placeholder;
  $("chat").classList.toggle("talked", turns.length > 0);
  renderCaption(state);
}

/** A rehearsal has no tab holding a model: the page streams a scripted placeholder answer in the tab's own shape (cumulative text, then done). */
function playRehearsalAnswer(id: string, prompt: string): void {
  const generation = take.generation;
  const steps = scriptedDeltas(scriptedAnswer(prompt));
  modelChat.handle({ type: "chat-start", id });
  steps.forEach((text, i) =>
    setTimeout(() => {
      if (take.generation !== generation) return;
      modelChat.handle(i === steps.length - 1 ? { type: "chat-done", id, text, refused: false } : { type: "chat-delta", id, text });
    }, 150 * (i + 1)),
  );
}

const chatIn = $<HTMLInputElement>("chatin");
const chatErr = $("chaterr");
$("chatform").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = chatIn.value.trim();
  if (!text) return;
  chatErr.hidden = true;
  // Once the tab says the chat switched, the line goes to the model it holds; before that, to the agent.
  if (take.model.phase === "switched") {
    const sent = modelChat.send(text);
    if (!sent.ok) {
      chatErr.textContent = sent.reason;
      chatErr.hidden = false;
      return;
    }
    chatIn.value = "";
    if (take.realModelSeen) bridge.send(sent.message as unknown as Parameters<typeof bridge.send>[0]);
    else playRehearsalAnswer(sent.message.id, sent.message.text);
    return;
  }
  chatIn.disabled = true;
  const r = await feed.command({ t: "ask", text }).catch((err) => ({ ok: false, message: err instanceof Error ? err.message : String(err) }));
  chatIn.disabled = false;
  if (r.ok) chatIn.value = "";
  else {
    chatErr.textContent = `The agent did not take that: ${r.message ?? "refused"}`;
    chatErr.hidden = false;
  }
  chatIn.focus();
});

feed.onChange(() => syncTake());
await feed.connect().catch((e) => {
  $("lost").hidden = false;
  $("lost").textContent = `no feed: ${e instanceof Error ? e.message : String(e)}`;
});
setInterval(frame, 120);
frame();

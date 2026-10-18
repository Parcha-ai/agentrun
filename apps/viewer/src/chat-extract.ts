// A recording made into the chat + report view's model from its generic events alone: each recorded conversation as a
// thread (its messages as recorded, the run's own thinking, one card per tool call), the session's spans (workflow
// nodes, LLM calls, tool calls, the model calls made inside a tool), what each look read, the run's cited answer and
// the agent's artifact. The same code for every run; pure but for reading a blob's JSON, which the caller passes.
import type { Json, Recording } from './format.ts';
import type { ChatCall, ChatDecision, ChatItem, ChatModel, ChatRow, ChatSource, ChatSpan, ChatThread } from './chat-model.ts';

type Obj = { [key: string]: Json };
const chatObj = (value: Json | undefined): Obj | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? value : undefined);
const chatStr = (value: Json | undefined): string | undefined => (typeof value === 'string' ? value : undefined);
const chatList = (value: Json | undefined): Json[] => (Array.isArray(value) ? value : []);
const chatId = (value: Json | undefined): string | undefined => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined);

/** A source address split into its file and its fragment's parameters (page, t, xywh). */
export function chatAddress(href: string): { file: string; params: URLSearchParams } {
  const at = href.indexOf('#');
  return { file: at < 0 ? href : href.slice(0, at), params: new URLSearchParams(at < 0 ? '' : href.slice(at + 1)) };
}

/** A cite's address: a whole one as written (file#fragment), or the cited file with the fragment's parameters, written
 *  with or without its '#'. */
export function chatCiteHref(fragment: string, file: string, fallback?: string): string {
  if (!fragment) return fallback ?? file;
  if (fragment.startsWith('#')) return `${file}${fragment}`;
  if (fragment.indexOf('#') > 0) return fragment;
  return /^[a-z]+=/.test(fragment) ? `${file}#${fragment}` : fragment;
}

/** The node runner's delivery tool: its reply on success is the runner's own, not the run's. */
const chatRunnerSubmit = 'submit';

const chatIsAddress = (value: string) => /^[\w./:%-]+\.[a-z0-9]{2,5}(#\S*)?$|^https?:\/\//i.test(value);

const chatClip = (text: string, size: number) => (text.length > size ? `${text.slice(0, size - 1)}…` : text);
const chatFirstLine = (text: string) => text.split('\n').map((line) => line.trim()).find((line) => /[\p{L}\p{N}]/u.test(line) && !/^<\/?[\w-]+>$/.test(line)) ?? '';

/** A value in plain form: a string as written, a yes-or-no in words, a list of scalars joined, a record as compact JSON. */
function chatPlain(value: Json | undefined): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value) && value.every((each) => typeof each !== 'object' || each === null)) return value.map(String).join(', ');
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** A failed result's first line: a JSON error record's message, else the first line of its words. */
function chatErrorLine(text: string): string {
  const raw = text.trim();
  if (raw.startsWith('{')) {
    try {
      const parsed = chatObj(JSON.parse(raw) as Json);
      const said = chatStr(chatObj(parsed?.error)?.message) ?? chatStr(parsed?.error) ?? chatStr(parsed?.message);
      if (said) return chatFirstLine(said);
    } catch { /* words */ }
  }
  return chatFirstLine(raw);
}

/** A value as one line: words by their first line, a list of scalars joined, a record (two levels deep) as its fields
 *  in plain form, anything deeper as compact JSON. */
function chatValueLine(value: Json | undefined, depth = 0): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return chatFirstLine(value);
  const record = chatObj(value);
  if (record && depth < 2) return Object.entries(record).map(([key, each]) => `${key}: ${chatValueLine(each, depth + 1)}`).join(' · ');
  return Array.isArray(value) && value.some((each) => typeof each === 'object' && each !== null) ? JSON.stringify(value) : chatPlain(value);
}

/** A result's line: a tool's `{ ok: true, value }` record reads as its value; anything else by its first line. */
function chatResultLine(text: string): string {
  const raw = text.trim();
  if (raw.startsWith('{')) {
    try {
      const parsed = chatObj(JSON.parse(raw) as Json);
      if (parsed?.ok === true && 'value' in parsed) return chatValueLine(parsed.value);
    } catch { /* words */ }
  }
  return chatFirstLine(raw);
}

/** A tool call in plain form: its name, the file or URL it acted on, then its short arguments as key=value; free text
 *  (an ask, a prompt) stays out of the title. One string argument alone is shown by its first line. */
export function chatToolTitle(name: string, args: Json | undefined): string {
  const a = chatObj(args);
  if (!a) return name;
  const entries = Object.entries(a);
  const only = entries.length === 1 ? entries[0] : undefined;
  if (only && typeof only[1] === 'string' && only[1].trim()) return `${name} ${chatClip(chatFirstLine(only[1]), 90)}`;
  const addressed = entries.find(([, value]) => typeof value === 'string' && chatIsAddress(value));
  const short = entries.filter(([key, value]) => key !== addressed?.[0] && (typeof value === 'number' || typeof value === 'boolean' || (typeof value === 'string' && value.length <= 24 && !value.includes('\n'))));
  const parts = [...(addressed ? [String(addressed[1])] : []), ...short.map(([key, value]) => `${key}=${value}`)];
  return chatClip(parts.length ? `${name} ${parts.join(' ')}` : name, 110);
}

/** The text of a message's content: a string, or its text parts joined. */
function chatText(content: Json | undefined): string {
  if (typeof content === 'string') return content;
  return chatList(content).map((part) => (chatObj(part)?.type === 'text' ? chatStr(chatObj(part)?.text) ?? '' : '')).join('');
}

/** A Jev answer (typed decisions) read as plain words, and the regions it found for marks it says are there. */
function chatDecisions(body: Obj): { text: string; decisions: ChatDecision[]; regions: { label: string; href: string }[] } {
  const parts: string[] = [];
  const decisions: ChatDecision[] = [];
  const boxes: { name: string; href: string }[] = [];
  for (const [name, decision] of Object.entries(body)) {
    const d = chatObj(decision);
    if (!d) continue;
    if (d.type === 'noul' && typeof d.noul === 'number') { parts.push(`${name.replace(/_/g, ' ')}: ${d.noul >= 0.5 ? 'yes' : 'no'}`); decisions.push({ name, kind: 'noul', score: d.noul }); }
    else if (d.type === 'choice' && typeof d.choice === 'string') { parts.push(`${name.replace(/_/g, ' ')}: ${d.choice}`); decisions.push({ name, kind: 'choice', choice: d.choice }); }
    else if (d.type === 'box' && typeof d.fragment === 'string') boxes.push({ name, href: d.fragment });
  }
  // A box for a mark the same answer says is not there is no finding: keep a region only when its yes-or-no is yes.
  const regions = boxes.filter((box) => {
    const present = chatObj(body[box.name.replace(/_at$/, '')]);
    return !(present?.type === 'noul' && typeof present.noul === 'number' && present.noul < 0.5);
  }).map((box) => ({ label: box.name.replace(/_at$/, '').replace(/_/g, ' '), href: box.href }));
  return { text: parts.join(' · '), decisions, regions };
}

/** A look's answer as one line (words, or decisions read plainly) and its regions. */
function chatLookAnswer(body: Json | undefined): { text: string; decisions: ChatDecision[]; regions: { label: string; href: string }[] } {
  const raw = chatStr(body)?.trim() ?? '';
  if (raw.startsWith('{')) {
    try { const parsed = chatObj(JSON.parse(raw) as Json); if (parsed) return chatDecisions(parsed); } catch { /* words */ }
  }
  return { text: chatClip(chatFirstLine(raw.replace(/^[\d.]+\t[\d.]+\t/gm, '')), 220), decisions: [], regions: [] };
}

/** A judge's call: its tool's verb is "judge" ("judge", "vision.judge"). */
const chatIsJudge = (tool: string) => tool.split('.').at(-1) === 'judge';

/** A model call's name: who answered (its `via`, else the tool's namespace) and the tool's verb, "Jev judge". */
function chatCallName(tool: string, via: string | undefined): string {
  const [space, ...verb] = tool.split('.');
  const name = verb.length ? `${via ?? space} ${verb.join(' ')}` : tool;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** A model call's line: its name, each score it gave (a yes-or-no's score, a choice, the confidence of a box no
 *  yes-or-no pairs), the boxes it drew; with none of those, its answer's first line. */
function chatCallLabel(name: string, body: Json | undefined): string {
  const written = typeof body === 'string' ? body : chatObj(body) ? JSON.stringify(body) : '';
  const { text, regions } = chatLookAnswer(written);
  let parsed: Obj | undefined;
  try { parsed = chatObj(JSON.parse(written) as Json); } catch { /* words */ }
  const scored: [string, string][] = [];
  for (const [key, decision] of Object.entries(parsed ?? {})) {
    const d = chatObj(decision);
    if (d?.type === 'noul' && typeof d.noul === 'number') scored.push([key, d.noul.toFixed(2)]);
    else if (d?.type === 'choice' && typeof d.choice === 'string') scored.push([key, d.choice]);
    else if (d?.type === 'box' && typeof d.confidence === 'number' && !(key.endsWith('_at') && chatObj(parsed?.[key.slice(0, -3)]))) scored.push([key, d.confidence.toFixed(2)]);
  }
  const parts = scored.map(([key, value]) => (scored.length > 1 ? `${key.replace(/_/g, ' ')} ${value}` : value));
  if (regions.length) parts.push(regions.length === 1 ? 'box drawn' : `${regions.length} boxes drawn`);
  if (!parts.length && text) parts.push(text);
  return chatClip([name, ...parts].join(' · '), 160);
}

/** A model call's output as recorded, a JSON one indented. */
function chatRaw(body: Json | undefined): string {
  const raw = typeof body === 'string' ? body : body === undefined || body === null ? '' : JSON.stringify(body);
  if (/^\s*[[{]/.test(raw)) { try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { /* as written */ } }
  return raw;
}

/** The chat + report view's model of a recording. `readJson` reads a blob's JSON (the run's cited result). */
export async function extractChat(recording: Recording, readJson: (sha: string) => Promise<Json | undefined>): Promise<ChatModel> {
  const { manifest } = recording;
  // A recording with no times keeps its file's order: each line placed at its position, the axis read as an order.
  const clocked = recording.lines.some((line) => typeof line.t === 'number' && line.t > 0);
  const lines = clocked ? recording.lines : recording.lines.map((line, index) => ({ ...line, t: index + 1, t0: undefined }));
  const given = chatObj(lines.find((line) => line.channel === 'durable' && line.kind === 'agentrun.workflow')?.data)?.input;
  const inputValue = chatObj(given)?.input;
  const input: ChatModel['input'] = typeof inputValue === 'string' ? { text: inputValue }
    : chatObj(inputValue) ? { fields: Object.entries(chatObj(inputValue)!).map(([name, value]) => ({ name, value: chatPlain(value) })) } : undefined;
  const live = (kind: string) => lines.filter((line) => line.channel === 'live' && line.kind === kind);

  // Workflow nodes: each node's label and span, and the conversation each agent node ran.
  const nodeAt = new Map<string, { label: string; t0?: number; t1?: number }>();
  for (const line of live('node.start')) nodeAt.set(line.path ?? '', { label: chatStr(chatObj(line.data)?.label) ?? line.path ?? 'node', t0: line.t });
  for (const line of live('node.end')) { const node = nodeAt.get(line.path ?? ''); if (node) node.t1 = line.t; }
  const pathOfConversation = new Map<string, string>();
  for (const line of lines) {
    if (line.kind !== 'agentrun.nodes' || line.channel !== 'durable') continue;
    const conversation = chatId(chatObj(chatObj(line.data)?.value)?.conversation);
    if (conversation && line.path) pathOfConversation.set(conversation, line.path);
  }

  // Tool calls' times, by call id, from the live start and end lines.
  const toolTimes = new Map<string, { t0?: number; t1?: number }>();
  for (const line of live('tool_execution_start')) {
    const id = chatStr(chatObj(line.data)?.toolCallId);
    if (id) toolTimes.set(id, { ...toolTimes.get(id), t0: line.t });
  }
  for (const line of live('tool_execution_end')) {
    const id = chatStr(chatObj(line.data)?.toolCallId);
    if (id) toolTimes.set(id, { ...toolTimes.get(id), t1: line.t });
  }

  // Each recorded conversation as a thread: its stored entries in file order, each entry once.
  const threads = new Map<string, ChatThread>();
  const toolItems = new Map<string, Extract<ChatItem, { kind: 'tool' }>>();
  const assistantItems = new Map<string, { id: string; t: number }[]>();
  const seen = new Set<string>();
  const prompted = new Set<string>();
  let counter = 0;
  const threadOf = (conversation: string, t: number): ChatThread => {
    let thread = threads.get(conversation);
    if (!thread) {
      const path = pathOfConversation.get(conversation);
      const node = path !== undefined ? nodeAt.get(path) : undefined;
      thread = { id: `thread-${conversation}`, label: node?.label ?? `conversation ${conversation}`, items: [], t0: node?.t0 ?? t, ...(node?.t1 !== undefined ? { t1: node.t1 } : {}) };
      threads.set(conversation, thread);
    }
    return thread;
  };
  const noteAssistant = (conversation: string, id: string, t: number) => {
    const list = assistantItems.get(conversation) ?? [];
    list.push({ id, t });
    assistantItems.set(conversation, list);
  };
  for (const line of lines) {
    if (line.channel !== 'durable' || !['pi.user', 'pi.assistant', 'pi.tool-result'].includes(line.kind)) continue;
    const d = chatObj(line.data);
    const conversation = chatId(d?.conversationId) ?? chatId(line.conv);
    const entry = chatId(d?.id);
    if (!conversation || (entry && seen.has(`${conversation}:${entry}`))) continue;
    if (entry) seen.add(`${conversation}:${entry}`);
    const thread = threadOf(conversation, line.t);
    for (const message of chatList(d?.model)) {
      const m = chatObj(message);
      if (!m) continue;
      if (line.kind === 'pi.user') {
        // With the run's input shown, a conversation's first user entry is the prompt the host composed from it, and
        // any later one is a message the host added.
        if (input && !prompted.has(conversation)) { prompted.add(conversation); continue; }
        const text = chatText(m.content);
        if (text.trim()) thread.items.push({ kind: input ? 'host' : 'user', id: `item-${++counter}`, text, t: line.t });
      } else if (line.kind === 'pi.assistant') {
        for (const part of chatList(m.content)) {
          const p = chatObj(part);
          if (!p) continue;
          if (p.type === 'thinking' && chatStr(p.thinking)?.trim()) thread.items.push({ kind: 'thinking', id: `item-${++counter}`, text: chatStr(p.thinking)!.trim(), t: line.t });
          else if (p.type === 'text' && chatStr(p.text)?.trim()) {
            const item = { kind: 'assistant' as const, id: `item-${++counter}`, text: chatStr(p.text)!.trim(), t: line.t };
            thread.items.push(item);
            noteAssistant(conversation, item.id, line.t);
          } else if (p.type === 'toolCall' && chatStr(p.id)) {
            const callId = chatStr(p.id)!;
            const name = chatStr(p.name) ?? 'tool';
            const times = toolTimes.get(callId);
            const item: Extract<ChatItem, { kind: 'tool' }> = { kind: 'tool', id: `item-${++counter}`, tool: name, title: chatToolTitle(name, p.arguments), takeaway: '', media: [], looks: [], calls: [], ...(chatIsJudge(name) ? { judge: true as const } : {}),
              ...(times?.t0 !== undefined ? { t0: times.t0 } : {}), ...(times?.t1 !== undefined ? { t1: times.t1 } : {}) };
            thread.items.push(item);
            toolItems.set(callId, item);
            noteAssistant(conversation, item.id, line.t);
          }
        }
      } else {
        const item = toolItems.get(chatStr(m.toolCallId) ?? '');
        if (!item) continue;
        if (m.isError === true) item.failed = true;
        item.takeaway = item.failed ? chatClip(chatErrorLine(chatText(m.content)), 220) : item.tool === chatRunnerSubmit ? '' : chatClip(chatResultLine(chatText(m.content)), 220);
        item.media = (line.blobs ?? []).filter((sha) => (recording.blobType(sha) ?? '').startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(recording.blobUrl(sha) ?? ''));
      }
    }
  }
  const ordered = [...threads.values()].sort((a, b) => (a.t0 ?? 0) - (b.t0 ?? 0));

  // The session's spans. Workflow nodes: start to end, each scrolling to its conversation.
  const spans: ChatSpan[] = [];
  for (const [path, node] of nodeAt) {
    if (node.t0 === undefined) continue;
    const conversation = [...pathOfConversation].find(([, p]) => p === path)?.[0];
    spans.push({ id: `span-${spans.length + 1}`, actor: 'node', lane: 'workflow', label: `node ${node.label}`, t0: node.t0, ...(node.t1 !== undefined ? { t1: node.t1 } : {}), ...(conversation ? { item: `thread-${conversation}` } : {}) });
  }
  // LLM calls: an assistant message's start to its end, in its conversation, labelled by the model that answered.
  const open = new Map<string, number>();
  for (const line of lines) {
    if (line.channel !== 'live' || (line.kind !== 'message_start' && line.kind !== 'message_end')) continue;
    const d = chatObj(line.data);
    const conversation = chatId(line.conv);
    if (!conversation) continue;
    if (line.kind === 'message_start') { if (chatObj(d?.message)?.role === 'assistant') open.set(conversation, line.t); continue; }
    const m = chatObj(chatList(chatObj(d?.entry)?.model)[0]);
    if (m?.role !== 'assistant' || !open.has(conversation)) continue;
    const t0 = open.get(conversation)!;
    open.delete(conversation);
    const model = chatStr(m.model) ?? chatStr(m.provider) ?? 'model';
    const item = (assistantItems.get(conversation) ?? []).find((each) => each.t >= t0)?.id;
    spans.push({ id: `span-${spans.length + 1}`, actor: 'llm', lane: `LLM ${model}`, label: `LLM ${model}`, t0, t1: line.t, item: item ?? `thread-${conversation}` });
  }
  // Tool calls: start to end. Inner model calls: one time each, nested under the innermost tool call of their
  // conversation whose span holds that time.
  const toolSpans: { span: ChatSpan; conversation?: string; callId: string }[] = [];
  for (const line of live('tool_execution_start')) {
    const d = chatObj(line.data);
    const callId = chatStr(d?.toolCallId);
    const name = chatStr(d?.toolName) ?? 'tool';
    if (!callId) continue;
    const item = toolItems.get(callId);
    const t1 = toolTimes.get(callId)?.t1;
    const span: ChatSpan = { id: `span-${spans.length + 1}`, actor: 'tool', lane: `tool ${name}`, label: item?.title ?? `tool ${name}`, t0: line.t, ...(t1 !== undefined ? { t1 } : {}), ...(item ? { item: item.id } : {}),
      ...(chatIsJudge(name) ? { judge: true as const } : {}) };
    spans.push(span);
    toolSpans.push({ span, conversation: chatId(line.conv), callId });
  }
  const lookItem = new Map<string, string>();
  // What a look filed about itself (its fragment, the image it was shown), by its key; and its key by its receipt.
  const lookFacts = new Map<string, Obj>();
  const receiptLook = new Map<string, string>();
  for (const line of live('LookEvent')) {
    const facts = chatObj(chatObj(chatObj(line.data)?.record)?.facts);
    const key = chatStr(facts?.key);
    if (facts && key && !lookFacts.has(key)) lookFacts.set(key, facts);
    const receipt = chatStr(chatObj(line.data)?.receipt);
    if (key && receipt) receiptLook.set(receipt, key);
  }
  for (const line of live('LookEvent')) {
    const d = chatObj(line.data);
    const tool = chatStr(d?.tool) ?? 'look';
    const model = chatStr(d?.model);
    const conversation = chatId(d?.conversationId);
    // A look line that names its parent call and its start is placed exactly; one that does not nests under the
    // innermost tool call of its conversation whose span holds its time.
    const parentId = chatStr(d?.parentToolCallId);
    const started = typeof (line as unknown as { t0?: unknown }).t0 === 'number' ? (line as unknown as { t0: number }).t0 : undefined;
    const holder = (parentId ? toolSpans.find((each) => each.callId === parentId) : undefined)
      ?? toolSpans.filter((each) => each.conversation === conversation && each.span.t0 <= line.t && (each.span.t1 ?? Infinity) >= line.t)
        .sort((a, b) => b.span.t0 - a.span.t0)[0];
    const record = chatObj(d?.record);
    const key = chatStr(chatObj(record?.facts)?.key);
    const item = holder ? toolItems.get(holder.callId) : undefined;
    if (item && key) { if (!item.looks.includes(key)) item.looks.push(key); lookItem.set(key, item.id); }
    const name = chatCallName(tool, chatStr(chatObj(record?.args)?.via));
    const judge = chatIsJudge(tool) ? { judge: true as const } : {};
    const call: ChatCall = { id: `call-${++counter}`, name, label: chatCallLabel(name, record?.body), raw: chatRaw(record?.body), ...(key ? { look: key } : {}), ...(model ? { model } : {}), ...judge,
      ...(started !== undefined ? { t0: started } : {}), t1: line.t };
    if (item) item.calls.push(call);
    spans.push({ id: `span-${spans.length + 1}`, actor: 'inner', lane: name, label: call.label, t0: started ?? line.t, ...(started !== undefined ? { t1: line.t } : {}),
      ...(holder ? { parentLane: holder.span.lane } : {}), ...(item ? { item: call.id } : {}), ...judge });
  }

  // Any other line with its own start (t0 on the recording's clock) is a model call made inside a tool: a span under
  // the call it names as its parent, else under the innermost tool call of its conversation whose span holds its start.
  for (const line of lines) {
    if (line.channel !== 'live' || line.kind === 'LookEvent' || line.kind.startsWith('tool_execution') || line.kind.startsWith('message_')) continue;
    const started = (line as unknown as { t0?: unknown }).t0;
    if (typeof started !== 'number') continue;
    const d = chatObj(line.data);
    const parentId = chatStr(d?.parentToolCallId);
    const conversation = chatId(d?.conversationId) ?? chatId(line.conv);
    const holder = (parentId ? toolSpans.find((each) => each.callId === parentId) : undefined)
      ?? toolSpans.filter((each) => each.conversation === conversation && each.span.t0 <= started && (each.span.t1 ?? Infinity) >= started)
        .sort((a, b) => b.span.t0 - a.span.t0)[0];
    if (!holder) continue;
    const model = chatStr(d?.model);
    const record = chatObj(d?.record);
    const tool = chatStr(d?.tool) ?? chatStr(d?.name) ?? line.kind;
    const name = chatCallName(tool, chatStr(chatObj(record?.args)?.via));
    const body = record?.body ?? d?.output;
    const judge = chatIsJudge(tool) ? { judge: true as const } : {};
    const call: ChatCall = { id: `call-${++counter}`, name, label: chatCallLabel(name, body), raw: chatRaw(body), ...(model ? { model } : {}), ...judge, t0: started, t1: line.t };
    const item = toolItems.get(holder.callId);
    if (item) item.calls.push(call);
    spans.push({ id: `span-${spans.length + 1}`, actor: 'inner', lane: name, parentLane: holder.span.lane, label: call.label, t0: started, t1: line.t, ...(item ? { item: call.id } : {}), ...judge });
  }

  // What each look read, by its key: its address, its answer, its images and the regions it boxed. One write can hold
  // several looks; each is keyed by its own record's key, the doc's key naming a write of one.
  const sources: Record<string, ChatSource> = {};
  const written = lines.filter((line) => line.kind === 'vision.looks' && line.channel === 'durable').flatMap((line) => {
    const looks = chatList(chatObj(chatObj(line.data)?.value)?.looks).map(chatObj).filter((look): look is Obj => !!look);
    return looks.map((look) => ({ look, key: chatStr(chatObj(chatObj(look.record)?.facts)?.key) ?? (looks.length === 1 ? chatStr(chatObj(line.data)?.key) : undefined) }));
  });
  for (const { look, key } of written) {
    const record = chatObj(look.record);
    const path = chatStr(chatObj(record?.args)?.path);
    if (!key || !path || sources[key]) continue;
    // An address with no fragment takes the one the look filed (a page, a time).
    const facts = lookFacts.get(key);
    const fragment = chatStr(facts?.fragment)?.replace(/^#/, '');
    // A look over several addresses files them joined by ", "; it opens at its first.
    const pieces = path.split(/,\s+/);
    const addresses = pieces.length > 1 && pieces.every(chatIsAddress) ? pieces : [path];
    const href = !addresses[0]!.includes('#') && fragment ? `${addresses[0]}#${fragment}` : addresses[0]!;
    const { text, decisions, regions } = chatLookAnswer(record?.body);
    const listed = chatList(look.images).map((each) => chatStr(each) ?? chatStr(chatObj(each)?.blob)).filter((sha): sha is string => !!sha && !!recording.blobUrl(sha));
    const shown = chatStr(facts?.sha256);
    const media = listed.length ? listed : shown && recording.blobUrl(shown) ? [shown] : [];
    // A look over several addresses files one picture for each, in their order.
    const pictures = addresses.length > 1 && listed.length === addresses.length ? addresses.map((each, index) => ({ href: index === 0 ? href : each, sha: listed[index]! })) : undefined;
    sources[key] = { href, ...(addresses.length > 1 ? { more: addresses.slice(1) } : {}), ...(pictures ? { pictures } : {}), takeaway: text, decisions, media, regions, ...(lookItem.has(key) ? { item: lookItem.get(key)! } : {}) };
  }

  // A call that made exactly one look says what that look found; its own first line is the tool's framing.
  for (const item of toolItems.values()) {
    const only = item.looks.length === 1 ? sources[item.looks[0]!] : undefined;
    if (only?.takeaway) item.takeaway = only.takeaway;
  }

  // The run's answer: its cited result, each cite on the look (and the card) that made it; else the result record it
  // submitted, a field of evidence paths as its cites; else its final assistant text.
  let answer: ChatModel['answer'];
  if (manifest.result?.blob) {
    const result = chatObj(await readJson(manifest.result.blob));
    if (result && result.format !== 'agentrun.cited/1') {
      const record = chatObj(result.record) ?? result;
      const evidence = new Set(chatList(result.evidence).map((each) => chatStr(each)).filter((each): each is string => !!each));
      const isCites = (value: Json) => Array.isArray(value) && value.length > 0 && value.every((each) => typeof each === 'string' && evidence.has(each));
      const rows: ChatRow[] = Object.entries(record).map(([name, value]) => (isCites(value)
        ? { label: name, text: '', cites: (value as string[]).map((href) => {
          const look = receiptLook.get(href);
          return { href, ...(look && sources[look] ? { look } : {}), ...(look && lookItem.has(look) ? { item: lookItem.get(look)! } : {}) };
        }) }
        : { label: name, text: chatPlain(value), cites: [] }));
      if (rows.length) answer = { title: manifest.result.title ?? manifest.title, rows, from: 'record' };
    }
    if (result?.format === 'agentrun.cited/1' && Array.isArray(result.rows)) {
      const rows: ChatRow[] = result.rows.map((row) => {
        const r = chatObj(row) ?? {};
        return {
          label: chatStr(r.label) ?? '', text: chatStr(r.value) ?? '', ...(chatStr(r.note)?.trim() ? { note: chatStr(r.note)!.trim() } : {}),
          cites: chatList(r.cites).map((cite) => {
            const c = chatObj(cite) ?? {};
            const look = chatStr(c.look);
            const source = look ? sources[look] : undefined;
            const note = chatStr(c.note);
            const named = note && chatIsAddress(note) ? note : undefined;
            const href = chatCiteHref(chatStr(c.fragment) ?? '', source ? chatAddress(source.href).file : named ?? '', source?.href);
            const blob = chatStr(c.blob);
            return { href, ...(look ? { look } : {}), ...(source?.item ? { item: source.item } : {}), ...(blob && recording.blobUrl(blob) ? { blob } : {}), ...(note && !named ? { label: note } : {}) };
          }),
        };
      });
      answer = { title: chatStr(result.title) ?? manifest.result.title ?? manifest.title, rows, from: 'cited' };
    }
  }
  if (!answer) {
    const last = ordered.flatMap((thread) => thread.items).filter((item) => item.kind === 'assistant').sort((a, b) => (a.t ?? 0) - (b.t ?? 0)).at(-1);
    if (last) answer = { title: manifest.title, rows: [{ label: '', text: last.text, cites: [] }], from: 'text' };
  }

  // The decisive look of each call: the one the answer cites, else the one scored highest.
  const cited = new Set((answer?.rows ?? []).flatMap((row) => row.cites.map((cite) => cite.look)).filter((look): look is string => !!look));
  for (const item of toolItems.values()) {
    const looks = item.looks.filter((look) => sources[look]);
    if (!looks.length) continue;
    const top = (look: string) => Math.max(-1, ...sources[look]!.decisions.map((each) => (each.kind === 'noul' ? each.score : -1)));
    const pick = looks.filter((look) => cited.has(look));
    for (const look of pick.length ? pick : [looks.reduce((best, look) => (top(look) > top(best) ? look : best))]) sources[look]!.decisive = true;
  }

  const times = lines.map((line) => line.t).filter((t) => typeof t === 'number' && t > 0);
  const resultLine = lines.findLast((line) => line.kind === 'result');
  const artifact = chatObj((manifest as { artifact?: Json }).artifact);
  const question = typeof inputValue === 'string' ? inputValue : chatStr(chatObj(inputValue)?.question);
  return {
    title: chatStr(artifact?.title) ?? (question?.trim() ? chatClip(chatFirstLine(question), 140) : manifest.title),
    ...(input ? { input } : {}),
    threads: ordered,
    spans: times.length ? spans : [],
    ...(clocked ? {} : { inOrder: true as const }),
    sources,
    ...(answer ? { answer } : {}),
    ...(artifact && chatStr(artifact.entry) && chatObj(artifact.files) ? { artifact: { title: chatStr(artifact.title) ?? manifest.title, entry: chatStr(artifact.entry)!, files: chatObj(artifact.files) as Record<string, string> } } : {}),
    ...(times.length ? { durationMs: Math.max(...times) } : {}),
    ...(resultLine ? { answeredAt: resultLine.t } : {}),
  };
}

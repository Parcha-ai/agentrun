// A recording made into the chat + report view's model from its generic events alone: each recorded conversation as a
// thread (its messages as recorded, the run's own thinking, one card per tool call), the session's spans (workflow
// nodes, LLM calls, tool calls, the model calls made inside a tool), what each look read, the run's cited answer and
// the agent's artifact. The same code for every run; pure but for reading a blob's JSON, which the caller passes.
import type { Json, Recording } from './format.ts';
import type { ChatItem, ChatModel, ChatRow, ChatSource, ChatSpan, ChatThread } from './chat-model.ts';

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

const chatClip = (text: string, size: number) => (text.length > size ? `${text.slice(0, size - 1)}…` : text);
const chatFirstLine = (text: string) => text.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? '';

/** A tool call in plain form: its name, the file or URL it acted on, then its short arguments as key=value; free text
 *  (an ask, a prompt) stays out of the title. One string argument alone is shown by its first line. */
export function chatToolTitle(name: string, args: Json | undefined): string {
  const a = chatObj(args);
  if (!a) return name;
  const entries = Object.entries(a);
  const only = entries.length === 1 ? entries[0] : undefined;
  if (only && typeof only[1] === 'string' && only[1].trim()) return `${name} ${chatClip(chatFirstLine(only[1]), 90)}`;
  const addressed = entries.find(([, value]) => typeof value === 'string' && /^[\w./:%-]+\.[a-z0-9]{2,5}(#\S*)?$|^https?:\/\//i.test(value));
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
function chatDecisions(body: Obj): { text: string; regions: { label: string; href: string }[] } {
  const parts: string[] = [];
  const boxes: { name: string; href: string }[] = [];
  for (const [name, decision] of Object.entries(body)) {
    const d = chatObj(decision);
    if (!d) continue;
    if (d.type === 'noul' && typeof d.noul === 'number') parts.push(`${name.replace(/_/g, ' ')}: ${d.noul >= 0.5 ? 'yes' : 'no'}`);
    else if (d.type === 'choice' && typeof d.choice === 'string') parts.push(`${name.replace(/_/g, ' ')}: ${d.choice}`);
    else if (d.type === 'box' && typeof d.fragment === 'string') boxes.push({ name, href: d.fragment });
  }
  // A box for a mark the same answer says is not there is no finding: keep a region only when its yes-or-no is yes.
  const regions = boxes.filter((box) => {
    const present = chatObj(body[box.name.replace(/_at$/, '')]);
    return !(present?.type === 'noul' && typeof present.noul === 'number' && present.noul < 0.5);
  }).map((box) => ({ label: box.name.replace(/_at$/, '').replace(/_/g, ' '), href: box.href }));
  return { text: parts.join(' · '), regions };
}

/** A look's answer as one line (words, or decisions read plainly) and its regions. */
function chatLookAnswer(body: Json | undefined): { text: string; regions: { label: string; href: string }[] } {
  const raw = chatStr(body)?.trim() ?? '';
  if (raw.startsWith('{')) {
    try { const parsed = chatObj(JSON.parse(raw) as Json); if (parsed) return chatDecisions(parsed); } catch { /* words */ }
  }
  return { text: chatClip(chatFirstLine(raw.replace(/^[\d.]+\t[\d.]+\t/gm, '')), 220), regions: [] };
}

/** The chat + report view's model of a recording. `readJson` reads a blob's JSON (the run's cited result). */
export async function extractChat(recording: Recording, readJson: (sha: string) => Promise<Json | undefined>): Promise<ChatModel> {
  const { manifest, lines } = recording;
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
        const text = chatText(m.content);
        if (text.trim()) thread.items.push({ kind: 'user', id: `item-${++counter}`, text, t: line.t });
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
            const item: Extract<ChatItem, { kind: 'tool' }> = { kind: 'tool', id: `item-${++counter}`, tool: name, title: chatToolTitle(name, p.arguments), takeaway: '', media: [], looks: [],
              ...(times?.t0 !== undefined ? { t0: times.t0 } : {}), ...(times?.t1 !== undefined ? { t1: times.t1 } : {}) };
            thread.items.push(item);
            toolItems.set(callId, item);
            noteAssistant(conversation, item.id, line.t);
          }
        }
      } else {
        const item = toolItems.get(chatStr(m.toolCallId) ?? '');
        if (!item) continue;
        item.takeaway = chatClip(chatFirstLine(chatText(m.content)), 220);
        item.media = (line.blobs ?? []).filter((sha) => (recording.blobType(sha) ?? '').startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(recording.blobUrl(sha) ?? ''));
        if (m.isError === true) item.failed = true;
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
    const span: ChatSpan = { id: `span-${spans.length + 1}`, actor: 'tool', lane: `tool ${name}`, label: item?.title ?? `tool ${name}`, t0: line.t, ...(t1 !== undefined ? { t1 } : {}), ...(item ? { item: item.id } : {}) };
    spans.push(span);
    toolSpans.push({ span, conversation: chatId(line.conv), callId });
  }
  const lookItem = new Map<string, string>();
  for (const line of live('LookEvent')) {
    const d = chatObj(line.data);
    const tool = chatStr(d?.tool) ?? 'look';
    const model = chatStr(d?.model);
    const conversation = chatId(d?.conversationId);
    // A look line that names its call and its start is placed exactly; one that does not nests under the innermost
    // tool call of its conversation whose span holds its one time.
    const parentId = chatStr(d?.toolCallId);
    const started = typeof d?.startedAt === 'number' ? d.startedAt : typeof d?.t0 === 'number' ? d.t0 : undefined;
    const holder = (parentId ? toolSpans.find((each) => each.callId === parentId) : undefined)
      ?? toolSpans.filter((each) => each.conversation === conversation && each.span.t0 <= line.t && (each.span.t1 ?? Infinity) >= line.t)
        .sort((a, b) => b.span.t0 - a.span.t0)[0];
    const key = chatStr(chatObj(chatObj(d?.record)?.facts)?.key);
    const item = holder ? toolItems.get(holder.callId) : undefined;
    if (item && key) { if (!item.looks.includes(key)) item.looks.push(key); lookItem.set(key, item.id); }
    spans.push({ id: `span-${spans.length + 1}`, actor: 'inner', lane: tool, label: model ? `${tool} ${model}` : tool, t0: started ?? line.t, ...(started !== undefined ? { t1: line.t } : {}),
      ...(holder ? { parentLane: holder.span.lane } : {}), ...(item ? { item: item.id } : {}) });
  }

  // What each look read, by its key: its address, its answer, its images and the regions it boxed.
  const sources: Record<string, ChatSource> = {};
  for (const line of lines) {
    if (line.kind !== 'vision.looks' || line.channel !== 'durable') continue;
    const key = chatStr(chatObj(line.data)?.key);
    const look = chatObj(chatList(chatObj(chatObj(line.data)?.value)?.looks)[0]);
    const record = chatObj(look?.record);
    const href = chatStr(chatObj(record?.args)?.path);
    if (!key || !href || sources[key]) continue;
    const { text, regions } = chatLookAnswer(record?.body);
    const media = chatList(look?.images).map((each) => chatStr(each) ?? chatStr(chatObj(each)?.blob)).filter((sha): sha is string => !!sha && !!recording.blobUrl(sha));
    sources[key] = { href, takeaway: text, media, regions, ...(lookItem.has(key) ? { item: lookItem.get(key)! } : {}) };
  }

  // A call that made exactly one look says what that look found; its own first line is the tool's framing.
  for (const item of toolItems.values()) {
    const only = item.looks.length === 1 ? sources[item.looks[0]!] : undefined;
    if (only?.takeaway) item.takeaway = only.takeaway;
  }

  // The run's cited answer, each cite on the look (and the card) that made it.
  let answer: ChatModel['answer'];
  if (manifest.result?.blob) {
    const result = chatObj(await readJson(manifest.result.blob));
    if (result?.format === 'agentrun.cited/1' && Array.isArray(result.rows)) {
      const rows: ChatRow[] = result.rows.map((row) => {
        const r = chatObj(row) ?? {};
        return {
          label: chatStr(r.label) ?? '', text: chatStr(r.value) ?? '',
          cites: chatList(r.cites).map((cite) => {
            const c = chatObj(cite) ?? {};
            const look = chatStr(c.look);
            const source = look ? sources[look] : undefined;
            const href = chatCiteHref(chatStr(c.fragment) ?? '', source ? chatAddress(source.href).file : chatStr(c.note) ?? '', source?.href);
            return { href, ...(look ? { look } : {}), ...(source?.item ? { item: source.item } : {}) };
          }),
        };
      });
      answer = { title: chatStr(result.title) ?? manifest.result.title ?? manifest.title, rows };
    }
  }

  const times = lines.map((line) => line.t).filter((t) => typeof t === 'number' && t > 0);
  const resultLine = lines.findLast((line) => line.kind === 'result');
  const artifact = chatObj((manifest as { artifact?: Json }).artifact);
  return {
    title: answer?.title ?? manifest.result?.title ?? manifest.title,
    threads: ordered,
    spans: times.length ? spans : [],
    sources,
    ...(answer ? { answer } : {}),
    ...(artifact && chatStr(artifact.entry) && chatObj(artifact.files) ? { artifact: { title: chatStr(artifact.title) ?? manifest.title, entry: chatStr(artifact.entry)!, files: chatObj(artifact.files) as Record<string, string> } } : {}),
    ...(times.length ? { durationMs: Math.max(...times) } : {}),
    ...(resultLine ? { answeredAt: resultLine.t } : {}),
  };
}

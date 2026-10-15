import { BROWSER_OPENERS, inputPreview, labelOf, savedPaths } from "./labels.js";
import { cut, firstLine, firstSentence, json, obj, scrubUrls, str, utf8Bytes } from "./util.js";
/** Grep's caps, so a row is the same on both sides. `thinking` cuts the first sentence of a thinking summary. */
export const CAPS = { summary: 500, preview: 500, text: 2000, thinking: 100 };
const TAG = /^[\w.-]{1,64}$/;
const blocksOf = (message) => {
    const content = message?.content;
    return Array.isArray(content) ? content.flatMap((block) => { const one = obj(block); return one ? [one] : []; }) : typeof content === "string" ? [{ type: "text", text: content }] : [];
};
const textOf = (message, type = "text", field = "text") => blocksOf(message).filter((block) => block.type === type).map((block) => str(block[field]) ?? "").join("\n").trim();
const dollars = (usd) => (usd === 0 ? "$0" : `$${usd.toFixed(4)}`);
/** One place turns entries into rows, whether they come from a released store or from live events. */
function createProjector(options) {
    const caps = { ...CAPS, ...options.caps };
    const label = (tool, args, result) => labelOf(tool, args, result, options.labels);
    const seen = new Set();
    const calls = new Map();
    const previous = new Map();
    const systems = new Set();
    const browsers = new Set();
    const children = new Map();
    const rows = [];
    let seq = 0;
    let stamp = 0;
    let root;
    let current = options.conversationId ?? 0;
    let requests = 0;
    let usd = 0;
    function make(kind, conv, id, fields = {}) {
        const timestamp = new Date(stamp).toISOString();
        const next = seq++;
        const row = {
            id, timestamp, created_at: timestamp, kind, summary: null, agent_label: options.agentLabel?.(conv) ?? null,
            tool_name: null, tool_use_id: null, tool_status: null, tool_input_preview: null, tool_result_preview: null,
            tool_result_size_bytes: null, text: null, conversation_id: conv, ...fields, seq: fields.seq ?? next,
        };
        const parent = fields.parent_tool_use_id ?? children.get(conv);
        if (parent !== undefined)
            row.parent_tool_use_id = parent;
        if (row.summary !== null)
            row.summary = cut(row.summary, caps.summary);
        if (row.text !== null)
            row.text = cut(row.text, caps.text);
        for (const key of ["round", "parent_tool_use_id", "session", "usage"])
            if (row[key] === undefined)
                delete row[key];
        return row;
    }
    const viewOf = (message) => ({ text: textOf(message), details: message.details, isError: message.isError === true });
    const failure = (text) => scrubUrls(firstLine(str(json(text)?.message) ?? text)) || "no detail";
    /** A call that spawned a conversation: its rows, and the child's, now name it as their parent. */
    function adopt(conv, child, callId, args, fallback) {
        if (children.has(child) || child === conv)
            return [];
        children.set(child, callId);
        const patched = rows.filter((row) => row.conversation_id === child);
        for (const row of patched)
            row.parent_tool_use_id = callId;
        const task = str(args.task) ?? str(args.prompt) ?? str(args.description) ?? fallback;
        const started = make("subagent_started", conv, `${conv}:sub:${callId}`, { summary: `Subagent: ${firstLine(task)}`, tool_use_id: callId });
        rows.push(started);
        return [...patched, started];
    }
    function push(entry) {
        const conv = entry.conversationId ?? options.conversationId ?? 0;
        if (entry.id !== undefined) {
            const key = `${conv}:${entry.id}`;
            if (seen.has(key))
                return [];
            seen.add(key);
        }
        root ??= conv;
        current = conv;
        const message = entry.model?.[0];
        const at = message?.timestamp;
        if (typeof at === "number" && Math.abs(at) <= 8.64e15)
            stamp = at;
        const base = `${conv}:${entry.id ?? seq}`;
        const out = [];
        const add = (row) => { rows.push(row); out.push(row); };
        const touch = (row) => { if (!out.includes(row))
            out.push(row); };
        if (entry.kind === "pi.assistant" && message) {
            requests += 1;
            const cost = obj(obj(message.usage)?.cost)?.total;
            usd = typeof cost === "number" && usd !== null ? usd + cost : null;
            if (message.stopReason === "error") {
                const why = str(message.errorMessage) ?? "unknown error";
                add(make("error", conv, base, { summary: `Model request failed: ${firstLine(why)}`, text: why }));
            }
            else if (message.stopReason !== "aborted") {
                const blocks = blocksOf(message);
                const first = (type) => blocks.findIndex((block) => block.type === type);
                const thinking = textOf(message, "thinking", "thinking");
                if (thinking)
                    add(make("thinking", conv, `${base}:${first("thinking")}`, { summary: `Thinking: ${cut(firstSentence(thinking), caps.thinking)}`, text: thinking }));
                const text = textOf(message);
                const final = message.stopReason === "stop" && !blocks.some((block) => block.type === "toolCall");
                if (text)
                    add(make(final ? "final_answer" : "text_block", conv, `${base}:${first("text")}`, { summary: firstLine(text), text }));
                blocks.forEach((block, index) => {
                    const [id, name] = [str(block.id), str(block.name)];
                    if (block.type !== "toolCall" || !id || !name)
                        return;
                    const args = obj(block.arguments) ?? {};
                    if (BROWSER_OPENERS.has(name) && !browsers.has(conv)) {
                        browsers.add(conv);
                        add(make("phase", conv, `${base}:${index}:session`, { summary: "Opened a live browser session" }));
                    }
                    const use = make("tool_use", conv, `${base}:${index}`, {
                        summary: label(name, args), tool_name: name, tool_use_id: id, tool_input_preview: inputPreview(args, caps.preview), round: entry.id,
                    });
                    calls.set(`${conv}:${id}`, { conv, name, args, round: entry.id, use, done: false });
                    add(use);
                });
            }
        }
        else if (entry.kind === "pi.tool-result" && message) {
            const id = str(message.toolCallId) ?? "";
            const call = calls.get(`${conv}:${id}`);
            const name = call?.name ?? str(message.toolName) ?? "tool";
            const args = call?.args ?? {};
            const view = viewOf(message);
            const named = label(name, args, view);
            if (call) {
                call.done = true;
                call.use.summary = cut(named, caps.summary);
                touch(call.use);
            }
            add(make("tool_result", conv, base, {
                summary: view.isError ? `${named} failed: ${failure(view.text)}` : `${named}: ok`, tool_name: name, tool_use_id: id || null,
                tool_status: view.isError ? "failed" : "success", tool_result_preview: view.text ? cut(scrubUrls(view.text), caps.preview) : null,
                tool_result_size_bytes: utf8Bytes(view.text), round: call?.round,
            }));
            if (!view.isError) {
                const answer = str(args.answer);
                if (name === "submit" && answer !== undefined)
                    add(make("final_answer", conv, `${base}:answer`, { summary: firstLine(answer), text: answer }));
                if (name === "request_sign_in") {
                    const reason = str(args.reason);
                    add(make("waiting", conv, `${base}:waiting`, { summary: `Waiting for you: ${reason ? firstLine(reason) : "sign in on the live browser"}` }));
                }
                if (name === "browser_release") {
                    browsers.delete(conv);
                    add(make("phase", conv, `${base}:phase`, { summary: "Released the browser session" }));
                }
                savedPaths(name, args, view).forEach((file, index) => add(make("phase", conv, `${base}:saved:${index}`, { summary: `Saved ${file}` })));
                const child = obj(message.details)?.conversationId;
                if (typeof child === "number") {
                    for (const row of adopt(conv, child, id, args, named))
                        touch(row);
                    add(make("subagent_completed", conv, `${conv}:done:${id}`, { summary: `Subagent done: ${scrubUrls(firstLine(view.text))}`, tool_use_id: id }));
                }
            }
        }
        else if (entry.kind === "pi.system") {
            if (systems.has(conv))
                add(make("phase", conv, base, { summary: "Tools changed" }));
            systems.add(conv);
        }
        else if (entry.kind === "pi.reset") {
            add(make("phase", conv, base, { summary: "Context reset", text: textOf(message) || null }));
        }
        else if (entry.kind === "pi.compaction") {
            add(make("phase", conv, base, { summary: "Summarized older context", text: textOf(message) || null }));
        }
        else if (entry.kind === "agent.handover") {
            const data = obj(entry.data);
            const [state, reason, tag] = [str(data?.state), str(data?.reason), str(data?.session)];
            const session = tag && TAG.test(tag) ? tag : undefined;
            if (state === "waiting")
                add(make("waiting", conv, base, { summary: `Waiting for you: ${reason ? firstLine(reason) : "sign in on the live browser"}`, session }));
            else if (state === "done")
                add(make("user_message", conv, base, { summary: "You signed in", session }));
            else if (state === "declined")
                add(make("user_message", conv, base, { summary: "You declined to sign in", session }));
        }
        else if (message?.role === "user" && (entry.kind === "pi.user" || !entry.kind.startsWith("pi."))) {
            const author = str(obj(entry.data)?.author);
            const steer = previous.get(conv) === "pi.tool-result";
            const text = textOf(message);
            add(make("user_message", conv, base, { summary: `${author ?? "You"}${steer ? " (steer)" : ""}: ${firstLine(text)}`, text }));
        }
        if (["pi.user", "pi.assistant", "pi.tool-result"].includes(entry.kind))
            previous.set(conv, entry.kind);
        return out;
    }
    /** A nested call: seen live only, since pi drops its result when the caller settles. */
    function nested(conv, id, parent, name, args) {
        const round = calls.get(`${conv}:${parent}`)?.round;
        const use = make("tool_use", conv, `${conv}:n:${id}`, {
            summary: label(name, args), tool_name: name, tool_use_id: id, tool_input_preview: inputPreview(args, caps.preview), round, parent_tool_use_id: parent,
        });
        calls.set(`${conv}:${id}`, { conv, name, args, round, use, done: false });
        rows.push(use);
        return use;
    }
    function nestedEnd(conv, id, parent, result) {
        const call = calls.get(`${conv}:${id}`);
        if (!call)
            return [];
        const output = result.structuredOutput;
        const diagnostic = Array.isArray(result.diagnostics) ? str(obj(result.diagnostics[0])?.message) : undefined;
        const text = typeof output === "string" ? output : output !== undefined ? JSON.stringify(output) : (diagnostic ?? "");
        const failed = result.isError === true;
        const named = label(call.name, call.args, { text, details: result.details, isError: failed });
        call.done = true;
        call.use.summary = cut(named, caps.summary);
        const row = make("tool_result", conv, `${conv}:n:${id}:result`, {
            summary: failed ? `${named} failed: ${failure(text)}` : `${named}: ok`, tool_name: call.name, tool_use_id: id,
            tool_status: failed ? "failed" : "success", tool_result_preview: text ? cut(scrubUrls(text), caps.preview) : null,
            tool_result_size_bytes: utf8Bytes(text), round: call.round, parent_tool_use_id: parent,
        });
        rows.push(row);
        return [call.use, row];
    }
    /** A call with no result that will never get one. */
    function interrupt(call, id) {
        call.done = true;
        const row = make("tool_result", call.conv, `${call.conv}:interrupted:${id}`, {
            summary: `${label(call.name, call.args)} interrupted`, tool_name: call.name, tool_use_id: id, tool_status: "failed", round: call.round,
            parent_tool_use_id: call.use.parent_tool_use_id,
        });
        rows.push(row);
        return row;
    }
    function open(conv) {
        return [...calls].filter(([, call]) => (conv === undefined || call.conv === conv) && !call.done).map(([key, call]) => [key.slice(key.indexOf(":") + 1), call]);
    }
    function usage() {
        if (!requests || root === undefined)
            return undefined;
        const total = usd === null ? null : Math.round(usd * 1e6) / 1e6;
        return make("usage", root, `${root}:usage`, {
            summary: `Cost so far: ${total === null ? "unknown" : dollars(total)} over ${requests} model request${requests === 1 ? "" : "s"}`,
            usage: { usd: total, requests },
        });
    }
    return {
        push, nested, nestedEnd, interrupt, open, usage,
        call: (conv, id) => calls.get(`${conv}:${id}`),
        adoptLive: (conv, id, child) => {
            const call = calls.get(`${conv}:${id}`);
            return call ? adopt(conv, child, id, call.args, call.use.summary ?? "") : [];
        },
        live: (kind, id, fields) => make(kind, current, id, fields),
        rows: () => rows,
        conv: () => current,
    };
}
/** Rows of a stored conversation, in log order. Pure: the same entries give the same rows. */
export function timelineOf(entries, options = {}) {
    const projector = createProjector(options);
    for (const entry of entries)
        projector.push(entry);
    if (options.settled)
        for (const [id, call] of projector.open())
            projector.interrupt(call, id);
    const usage = projector.usage();
    return usage ? [...projector.rows(), usage] : [...projector.rows()];
}
const roleOf = (entry) => {
    const model = obj(entry)?.model;
    return Array.isArray(model) ? obj(model[0])?.role : undefined;
};
const modelName = (agent) => {
    const model = obj(obj(agent)?.model);
    return model && str(model.modelId) ? `${str(model.provider) ?? "model"}/${str(model.modelId)}` : undefined;
};
/** Live rows from `watchEvents` batches. Committed entries go through the same projector `timelineOf` uses. */
export function timelineReducer(options = {}) {
    const now = options.now ?? Date.now;
    let projector = createProjector(options);
    const store = new Map();
    const streams = { thinking: new Map(), text_block: new Map() };
    let model;
    function apply(events) {
        const changed = new Map();
        const dropped = new Set();
        const put = (row) => { store.set(row.id, row); changed.set(row.id, row); dropped.delete(row.id); };
        const del = (id) => { if (store.delete(id)) {
            changed.delete(id);
            dropped.add(id);
        } };
        const live = (kind, id, summary, fields = {}) => {
            const old = store.get(id);
            if (summary === undefined)
                return del(id);
            if (old && old.summary === summary && old.text === (fields.text ?? null))
                return;
            put(projector.live(kind, id, { summary, ...fields, seq: old?.seq }));
        };
        let committed = false;
        const entry = (value) => {
            const e = obj(value);
            if (!e || typeof e.kind !== "string")
                return;
            for (const row of projector.push(e))
                put(row);
            committed = true;
        };
        const conv = () => projector.conv();
        const showStreams = () => {
            for (const kind of ["thinking", "text_block"]) {
                const text = [...streams[kind].values()].join("").trim();
                const summary = kind === "thinking" ? `Thinking: ${cut(firstSentence(text), CAPS.thinking)}` : firstLine(text);
                live(kind, `${conv()}:live:${kind}`, text ? summary : undefined, { text });
            }
        };
        const endStreams = () => {
            streams.thinking.clear();
            streams.text_block.clear();
            showStreams();
        };
        const readMessage = (message) => {
            streams.thinking.clear();
            streams.text_block.clear();
            blocksOf(message).forEach((block, index) => {
                if (block.type === "thinking")
                    streams.thinking.set(index, str(block.thinking) ?? "");
                else if (block.type === "text")
                    streams.text_block.set(index, str(block.text) ?? "");
            });
        };
        const change = (c) => {
            const index = typeof c.contentIndex === "number" ? c.contentIndex : 0;
            const block = obj(c.block);
            const append = (map) => map.set(index, (map.get(index) ?? "") + (str(c.delta) ?? ""));
            if (c.type === "text_delta")
                append(streams.text_block);
            else if (c.type === "thinking_delta")
                append(streams.thinking);
            else if (c.type === "text_start" || (c.type === "block" && block?.type === "text"))
                streams.text_block.set(index, str(block?.text) ?? "");
            else if (c.type === "thinking_start" || (c.type === "block" && block?.type === "thinking"))
                streams.thinking.set(index, str(block?.thinking) ?? "");
            else if (c.type === "message")
                readMessage(obj(c.message));
        };
        const wait = (slot, summary) => live("waiting", `${conv()}:waiting:${slot}`, summary);
        const seconds = (at) => Math.max(0, Math.round(((typeof at === "number" ? at : now()) - now()) / 1000));
        const nestedStart = (id, parent, name, args) => {
            if (!projector.call(conv(), id))
                put(projector.nested(conv(), id, parent, name, args));
        };
        for (const event of events) {
            switch (event.type) {
                case "snapshot": {
                    for (const id of store.keys())
                        dropped.add(id);
                    store.clear();
                    changed.clear();
                    projector = createProjector(options);
                    streams.thinking.clear();
                    streams.text_block.clear();
                    model = modelName(event.agent);
                    for (const value of Array.isArray(event.entries) ? event.entries : [])
                        entry(value);
                    const generation = obj(event.generation);
                    const retry = obj(generation?.retry);
                    if (generation?.message) {
                        readMessage(obj(generation.message));
                        showStreams();
                    }
                    if (retry)
                        wait("retry", `Retrying in ${seconds(retry.at)} s: ${firstLine(str(retry.error) ?? "")}`);
                    if (obj(generation?.deferred))
                        wait("poll", "Waiting for the model provider");
                    if (Array.isArray(event.inbox) && event.inbox.length)
                        wait("queue", `${event.inbox.length} message${event.inbox.length === 1 ? "" : "s"} queued`);
                    for (const slot of Array.isArray(event.nestedTools) ? event.nestedTools : []) {
                        const s = obj(slot);
                        if (s && str(s.callId) && str(s.parentCallId) && str(s.name))
                            nestedStart(s.callId, s.parentCallId, s.name, obj(s.arguments) ?? {});
                    }
                    break;
                }
                case "message_start":
                    if (obj(event.message)?.role === "assistant")
                        endStreams();
                    break;
                case "message_update":
                    for (const c of Array.isArray(event.changes) ? event.changes : [])
                        change(obj(c) ?? {});
                    showStreams();
                    break;
                case "message_end": {
                    entry(event.entry);
                    if (roleOf(event.entry) === "assistant")
                        endStreams();
                    break;
                }
                case "entry_appended":
                    entry(event.entry);
                    break;
                case "tool_execution_start": {
                    const parent = str(event.parentToolCallId);
                    if (parent && str(event.toolCallId))
                        nestedStart(event.toolCallId, parent, str(event.toolName) ?? "tool", obj(event.args) ?? {});
                    break;
                }
                case "tool_execution_end": {
                    const id = str(event.toolCallId) ?? "";
                    if (event.entry)
                        entry(event.entry);
                    else if (obj(event.result))
                        for (const row of projector.nestedEnd(conv(), id, str(event.parentToolCallId), obj(event.result)))
                            put(row);
                    else {
                        const call = projector.call(conv(), id);
                        if (call && !call.done)
                            put(projector.interrupt(call, id));
                    }
                    break;
                }
                case "run_start":
                    live("phase", `${conv()}:run:start`, "Run started");
                    break;
                case "run_end":
                    for (const [id, call] of projector.open(conv()))
                        put(projector.interrupt(call, id));
                    live("phase", `${conv()}:run:end`, "Run finished");
                    break;
                case "inbox_update": {
                    const n = Array.isArray(event.items) ? event.items.length : 0;
                    wait("queue", n ? `${n} message${n === 1 ? "" : "s"} queued` : undefined);
                    break;
                }
                case "auto_retry_start":
                    wait("retry", `Retrying in ${seconds(event.at)} s (attempt ${String(event.attempt)}): ${firstLine(str(event.errorMessage) ?? "")}`);
                    break;
                case "auto_retry_end":
                    wait("retry", undefined);
                    break;
                case "deferred_poll":
                    wait("poll", `Waiting for the model provider (next check in ${seconds(event.pollAt)} s)`);
                    break;
                case "agent_changed": {
                    const next = modelName(event.agent);
                    if (next && model && next !== model)
                        live("phase", `${conv()}:model:${next}`, `Model changed to ${next}`);
                    model = next ?? model;
                    break;
                }
                case "task_failed":
                    live("error", `${conv()}:task:${String(event.taskId)}`, `Task failed: ${firstLine(str(event.message) ?? "")}`, { text: str(event.message) ?? null });
                    break;
                case "compaction_start":
                    live("phase", `${conv()}:compaction:${String(event.taskId)}`, "Summarizing older context");
                    break;
                case "compaction_end":
                    del(`${conv()}:compaction:${String(event.taskId)}`);
                    if (str(event.error))
                        live("error", `${conv()}:compaction:${String(event.taskId)}:error`, `Compaction failed: ${firstLine(str(event.error))}`, { text: str(event.error) });
                    break;
                case "tool_execution_update": {
                    const child = obj(event.details)?.conversationId;
                    const id = str(event.toolCallId);
                    if (typeof child === "number" && id)
                        for (const row of projector.adoptLive(conv(), id, child))
                            put(row);
                    break;
                }
                default:
                    break;
            }
        }
        const usage = committed ? projector.usage() : undefined;
        if (usage)
            put(usage);
        return { rows: [...changed.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)), drop: [...dropped] };
    }
    return {
        apply,
        /** Every row now, in log order. */
        rows: () => [...store.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)),
    };
}

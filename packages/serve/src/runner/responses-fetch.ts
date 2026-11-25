// OpenAI's Responses API over the route's own Messages translation (model-route.ts messagesFetch), for a model that
// speaks neither wire (an Ollama model: TRANSLATED), so a harness on the openai-responses wire (codex, opencode, any
// other) runs it as pi and claude-agent do, on the one translation: the same pi-ai model (num_ctx, tools as text), the
// same redaction of errors and reasoning, the same text-tools re-asks and the same booking of a failed answer.
//   Request: a stateless Responses body becomes one Messages body. `instructions` and the system or developer messages
//     before the first turn are the system prompt; one later is a user turn's text. A `function_call` is a tool_use
//     under its own call_id and its `function_call_output` the tool_result of that id; reasoning items are dropped (the
//     Messages translation drops replayed thinking too). Function tools alone: a `custom` (freeform) tool, an
//     `item_reference`, a file or an image by URL is refused with a 400 naming it, never dropped in silence. So is a
//     `tool_choice` that forces a call ("required", or one naming a function): Ollama cannot be made to call a tool, and
//     a forced call run as "auto" would be a promise the route breaks. "auto" is taken, and "none" sends no tool.
//     `text.format` json_schema is Ollama's `format` (the answer held to the schema), json_object an object schema;
//     beside tools sent it is refused, since the model could call none. temperature and top_p reach Ollama's options;
//     `reasoning.effort` is a thinking model's level (Ollama's think), and "none" asks it not to think. An effort or a
//     format this route does not know is refused. parallel_tool_calls false keeps an answer's first call alone, since
//     Ollama's chat has no switch for one call per answer, and warns the names of those it drops. What this asks Ollama
//     past the Messages body rides the in-process call (EdgeAsks), never the body: the Messages wire stays as it is.
//   Answer: the Messages stream becomes a Responses stream: response.created, an output item for each block (message,
//     reasoning, function_call) with its deltas and its done events, then response.completed, or response.incomplete
//     with `incomplete_details.reason: "max_output_tokens"` where the model stopped at its output limit, both carrying
//     the usage (OpenAI's shape: cached tokens inside input_tokens). A failure is response.failed, with the usage the
//     translation reported before it, so the proxy books the tokens a failed answer used. A part of the Messages stream
//     that does not read, or a stream that breaks, is a failure in words of its own (UNREAD), never that part's text.
// State: none is kept. A request is its whole conversation: one that asks `store: true` or names `previous_response_id`
// is refused, since nothing is stored here to continue from. `include` is read for nothing: this writes no encrypted
// reasoning, and a replayed reasoning item (OpenAI's encrypted one included) is dropped, never refused.
// A request streams only with `stream: true`, as OpenAI's API does; one with `stream: false` or none gets the final
// response as one JSON body.
// The answer runs through messagesFetch whole (a Responses body made a Messages one, its Messages stream made a Responses
// one), so the Messages translation stays as it is. Split into a parser per wire, one driver and an encoder per wire if a
// third wire arrives.
import { randomBytes } from "node:crypto";

type Json = Record<string, unknown>;
type MessagesBlock = { type: string; [key: string]: unknown };
type MessagesMessage = { role: "user" | "assistant"; content: MessagesBlock[] };

/** A request this translation does not take: answered 400 with `message`, in OpenAI's error shape. */
export class ResponsesRefusal extends Error {}

const isPlain = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const idOf = (prefix: string): string => `${prefix}_${randomBytes(12).toString("hex")}`;

/** pi's thinking levels a Responses `reasoning.effort` may name and the Messages translation asks by name. */
const EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

/** A Responses message's content as Messages blocks: text, and an image only as base64 (a data URL). */
function partsOf(content: unknown, role: string): MessagesBlock[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part): MessagesBlock[] => {
    if (!isPlain(part)) return [];
    if (part.type === "input_text" || part.type === "output_text") return [{ type: "text", text: String(part.text ?? "") }];
    if (part.type === "refusal") return [{ type: "text", text: String(part.refusal ?? "") }];
    if (part.type === "input_image") {
      const url = typeof part.image_url === "string" ? part.image_url : "";
      const data = /^data:([^;,]+);base64,(.*)$/s.exec(url);
      if (!data) throw new ResponsesRefusal(`an image by URL or file id in a ${role} message is not taken on this model's route: send it as a data URL`);
      return [{ type: "image", source: { type: "base64", media_type: data[1], data: data[2] } }];
    }
    throw new ResponsesRefusal(`a ${String(part.type)} part in a ${role} message is not taken on this model's route`);
  });
}

/** A function_call_output's output as a tool_result's content: its text, or its text and image parts. */
function outputOf(output: unknown): string | MessagesBlock[] {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return partsOf(output, "tool output");
  return output === undefined || output === null ? "" : JSON.stringify(output);
}

/** The tool call's arguments as the object a tool_use carries: its JSON, or none where it is not an object's. */
function argumentsOf(text: unknown): Json {
  if (isPlain(text)) return text;
  try {
    const parsed = JSON.parse(String(text ?? "{}")) as unknown;
    return isPlain(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Throws a ResponsesRefusal for a `tool_choice` other than "auto" or "none" (or none at all): the model behind the route
 *  (Ollama's chat) takes no tool choice, so a call forced by "required" or by a function's name, or tools narrowed by
 *  "allowed_tools", cannot be kept. */
function refuseForcedChoice(choice: unknown): void {
  if (choice === undefined || choice === null || choice === "auto" || choice === "none") return;
  const unkept = "is not taken on this model's route: the model here cannot be made to call a tool, so send \"auto\"";
  if (choice === "required") throw new ResponsesRefusal(`tool_choice "required" ${unkept}`);
  if (isPlain(choice) && choice.type === "function") throw new ResponsesRefusal(`tool_choice naming the function ${String(choice.name ?? "(none)")} ${unkept}`);
  throw new ResponsesRefusal(`tool_choice ${JSON.stringify(isPlain(choice) ? (choice.type ?? "(no type)") : choice)} is not taken on this model's route: "auto" and "none" only`);
}

/**
 * A Responses request as one Messages request (see the head of this file). `reasons`: whether the model reasons, so a
 * `reasoning.effort` reaches it as the Messages translation's named level; a model that does not is asked none.
 * Returns the Messages body and what it asks Ollama past it (EdgeAsks). Throws a ResponsesRefusal for what it does not take.
 */
export function messagesOfResponses(body: Json, reasons: boolean): { request: Json; asks: EdgeAsks } {
  if (body.store === true) throw new ResponsesRefusal("store: true is not taken on this model's route: nothing is stored here, so send store: false and the whole conversation");
  if (body.previous_response_id !== undefined && body.previous_response_id !== null) throw new ResponsesRefusal("previous_response_id is not taken on this model's route: no response is stored here, so send the whole conversation");
  refuseForcedChoice(body.tool_choice);
  const system: string[] = [];
  if (typeof body.instructions === "string" && body.instructions) system.push(body.instructions);
  const messages: MessagesMessage[] = [];
  const push = (role: "user" | "assistant", blocks: MessagesBlock[]) => {
    if (!blocks.length) return;
    const last = messages.at(-1);
    // One Messages turn per run of items of one role: an answer's text and its calls are one assistant turn, and the
    // outputs of its calls one user turn, as a Messages client sends them.
    if (last?.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  const input = typeof body.input === "string" ? [{ type: "message", role: "user", content: body.input }] : Array.isArray(body.input) ? body.input : [];
  for (const item of input) {
    if (!isPlain(item)) throw new ResponsesRefusal("an input item that is not an object is not taken on this model's route");
    const type = item.type ?? (item.role !== undefined ? "message" : undefined);
    if (type === "message") {
      const role = String(item.role ?? "");
      if (role === "system" || role === "developer") {
        const text = partsOf(item.content, role).filter((part) => part.type === "text").map((part) => String(part.text)).join("\n");
        // Before the first turn, the system prompt; after it, the turn's own text, so the prompt the model has already
        // read stays the same from request to request.
        if (!messages.length) {
          if (text) system.push(text);
        } else if (text) push("user", [{ type: "text", text }]);
      } else if (role === "user") push("user", partsOf(item.content, role));
      else if (role === "assistant") push("assistant", partsOf(item.content, role));
      else throw new ResponsesRefusal(`a message of role ${role || "(none)"} is not taken on this model's route`);
    } else if (type === "function_call") {
      push("assistant", [{ type: "tool_use", id: String(item.call_id ?? ""), name: String(item.name ?? ""), input: argumentsOf(item.arguments) }]);
    } else if (type === "function_call_output") {
      push("user", [{ type: "tool_result", tool_use_id: String(item.call_id ?? ""), content: outputOf(item.output) }]);
    } else if (type === "reasoning") {
      // Replayed reasoning is not sent back to the model, as the Messages translation drops a replayed thinking block:
      // OpenAI's encrypted reasoning (encrypted_content) is no text a local model could read, and this route's own carries
      // only a summary of what the model already acted on. Dropped, never refused, so a replayed turn goes on.
    } else {
      throw new ResponsesRefusal(`a ${String(type)} input item is not taken on this model's route${type === "item_reference" ? ": send the whole conversation (store is off)" : ""}`);
    }
  }
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const functions = tools.map((tool) => {
    if (!isPlain(tool) || tool.type !== "function") throw new ResponsesRefusal(`a ${isPlain(tool) ? String(tool.type) : "malformed"} tool is not taken on this model's route: function tools only${isPlain(tool) && tool.type === "custom" ? " (a custom, freeform tool has no function schema to give the model)" : ""}`);
    return { name: String(tool.name ?? ""), description: typeof tool.description === "string" ? tool.description : "", input_schema: isPlain(tool.parameters) ? tool.parameters : { type: "object", properties: {} } };
  });
  const sendsTools = functions.length > 0 && body.tool_choice !== "none";
  const schema = schemaOf(body.text, sendsTools);
  // Ollama holds the answer to the schema (its `format`); the schema is in the prompt too, as Ollama advises, so the
  // model writes what the schema means and not only its shape.
  if (schema) system.push(`Answer with one JSON value only, no other text, matching this JSON schema:\n${JSON.stringify(schema)}`);
  const effort = isPlain(body.reasoning) ? body.reasoning.effort : undefined;
  if (effort !== undefined && effort !== null && !(typeof effort === "string" && (EFFORTS.has(effort) || effort === "none"))) throw new ResponsesRefusal(`reasoning.effort ${JSON.stringify(effort)} is not taken on this model's route: "none", ${[...EFFORTS].map((each) => `"${each}"`).join(", ")} only`);
  const level = reasons && typeof effort === "string" && EFFORTS.has(effort) ? effort : undefined;
  // "none" on a model that reasons: Ollama is asked not to think (think: false), where its own default would have the
  // model think.
  const off = reasons && effort === "none";
  const request = {
    model: typeof body.model === "string" ? body.model : "route",
    stream: true,
    ...(typeof body.max_output_tokens === "number" ? { max_tokens: body.max_output_tokens } : {}),
    ...(system.length ? { system: system.join("\n\n") } : {}),
    messages,
    ...(sendsTools ? { tools: functions } : {}),
    ...(level ? { thinking: { type: "adaptive" }, output_config: { effort: level } } : {}),
  };
  const asks: EdgeAsks = { ...(schema ? { format: schema } : {}), ...numberOf(body, "temperature"), ...numberOf(body, "top_p"), ...(off ? { think: false as const } : {}) };
  return { request, asks };
}

/** What this edge asks an Ollama model past the Messages body: the JSON schema its answer is held to (Ollama's `format`),
 *  its temperature and top_p, and no thinking (effort "none"). Handed to the route's Messages fetch on the in-process
 *  call's init (`edgeAsks`; model-route.ts messagesFetch reads it on an Ollama model alone), never in the body, so the
 *  Messages wire a Messages client speaks stays as it is: its own fields of these names reach Ollama as before, not at all. */
export type EdgeAsks = { format?: Json; temperature?: number; top_p?: number; think?: false };

/** `field` of `body` (temperature, top_p) as this edge asks it of Ollama (EdgeAsks): a number as it is, null or absent as
 *  none (the model's own default). Anything else is refused, never dropped. */
function numberOf(body: Json, field: "temperature" | "top_p"): { temperature?: number; top_p?: number } {
  const value = body[field];
  if (value === undefined || value === null) return {};
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ResponsesRefusal(`${field} ${JSON.stringify(value)} is not taken on this model's route: a number, or null for the model's default`);
  return field === "temperature" ? { temperature: value } : { top_p: value };
}

/** The JSON schema `text.format` holds the answer to: json_schema's own, json_object's any object; none for a text format
 *  or none. Ollama holds the whole answer to it (constrained decoding), which leaves the model no way to call a tool, so a
 *  format beside tools sent is refused, as is one of another type: never asked in words alone. */
function schemaOf(text: unknown, sendsTools: boolean): Json | undefined {
  const format = isPlain(text) ? text.format : undefined;
  if (format === undefined || format === null || (isPlain(format) && format.type === "text")) return undefined;
  const type = isPlain(format) ? format.type : undefined;
  if (type !== "json_schema" && type !== "json_object") throw new ResponsesRefusal(`text.format ${JSON.stringify(type ?? format)} is not taken on this model's route: "text", "json_schema" and "json_object" only`);
  const schema = type === "json_object" ? { type: "object" } : (format as Json).schema;
  if (!isPlain(schema)) throw new ResponsesRefusal("text.format json_schema with no schema object is not taken on this model's route");
  if (sendsTools) throw new ResponsesRefusal(`text.format ${type} beside tools is not taken on this model's route: Ollama holds the whole answer to the format, which leaves the model no way to call a tool, so drop the output schema, or use a model route that takes tools with a format (or send tool_choice "none")`);
  return schema;
}

/** One Messages SSE event: its JSON data, or, for an error event whose data is the error's words alone, those words; any
 *  other part that is not a JSON object is `unread`, its text never said. */
type MessagesEvent = { json?: Json; words?: string; name?: string; unread?: true };

/** What a failed response says of a Messages stream a part of which does not read: never that part's own text. */
const UNREAD = "The model's answer could not be read: a part of it is not JSON, or its stream broke.";

/** The events of a Messages SSE body, as they come. */
async function* messagesEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<MessagesEvent> {
  const decoder = new TextDecoder();
  let held = "";
  const eventOf = (block: string): MessagesEvent | undefined => {
    let name: string | undefined;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) name = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
    }
    if (!data.length) return undefined;
    const text = data.join("\n");
    try {
      const json = JSON.parse(text) as unknown;
      if (isPlain(json)) return { json, ...(name ? { name } : {}) };
    } catch {}
    // An error event's words alone (messagesFetch sendWords); anything else that does not read is said as UNREAD.
    return name === "error" ? { words: text, name } : { unread: true };
  };
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    held += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let end: number;
    while ((end = held.indexOf("\n\n")) >= 0) {
      const event = eventOf(held.slice(0, end));
      held = held.slice(end + 2);
      if (event) yield event;
    }
  }
  held += decoder.decode();
  const last = held.trim() ? eventOf(held) : undefined;
  if (last) yield last;
}

/** A Messages usage object as Responses states it: the cached and cache-write tokens inside input_tokens. */
function usageOf(usage: Json | undefined): Json {
  const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
  const input = count(usage?.input_tokens);
  const cacheRead = count(usage?.cache_read_input_tokens);
  const cacheWrite = count(usage?.cache_creation_input_tokens);
  const output = count(usage?.output_tokens);
  const details = isPlain(usage?.output_tokens_details) ? usage.output_tokens_details : {};
  const cost = usage?.cost;
  return {
    input_tokens: input + cacheRead + cacheWrite,
    input_tokens_details: { cached_tokens: cacheRead, ...(cacheWrite ? { cache_write_tokens: cacheWrite } : {}) },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: count(details.thinking_tokens) },
    total_tokens: input + cacheRead + cacheWrite + output,
    ...(typeof cost === "number" ? { cost } : {}),
  };
}

/** An output item being written: its Responses item, and for a block of text or reasoning its text so far. */
type Open = { index: number; item: Json; text: string; kind: "message" | "reasoning" | "function_call" };

/**
 * A fetch that answers OpenAI Responses requests through `messages` (a Messages fetch: the route's own translation,
 * model-route.ts messagesFetch). `reasons`: whether the model reasons (messagesOfResponses). A request it does not take
 * is answered 400 and never reaches `messages`. `warn`: where a line on what the edge did to an answer goes (the calls
 * parallel_tool_calls false kept from the client, by count and tool name, never their arguments); stderr by default,
 * which the run's own log keeps.
 */
export function responsesFetch(messages: typeof fetch, { reasons = false, warn = (line: string) => console.warn(line) }: { reasons?: boolean; warn?: (line: string) => void } = {}): typeof fetch {
  return (async (url: unknown, init: { body?: unknown; signal?: AbortSignal; headers?: unknown } = {}) => {
    let body: Json;
    let request: Json;
    let asks: EdgeAsks;
    try {
      const parsed = JSON.parse(String(init.body ?? "{}")) as unknown;
      if (!isPlain(parsed)) throw new ResponsesRefusal("the request body is not a JSON object");
      body = parsed;
      ({ request, asks } = messagesOfResponses(body, reasons));
    } catch (error) {
      const message = error instanceof ResponsesRefusal ? error.message : "the request body is not JSON";
      return new Response(JSON.stringify({ error: { message, type: "invalid_request_error", param: null, code: null } }), { status: 400, headers: { "content-type": "application/json" } });
    }
    const target = String(url).replace(/\/v1\/responses(?=$|\?)/, "/v1/messages");
    const answer = await messages(target, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request), edgeAsks: asks, ...(init.signal ? { signal: init.signal } : {}) } as RequestInit);
    if (!answer.ok || !answer.body) {
      const text = await answer.text().catch(() => "");
      return new Response(JSON.stringify({ error: { message: text || `the model's request failed (${answer.status})`, type: "server_error", param: null, code: null } }), { status: answer.status >= 400 ? answer.status : 500, headers: { "content-type": "application/json" } });
    }
    const response: Json = {
      id: idOf("resp"),
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "in_progress",
      background: false,
      error: null,
      incomplete_details: null,
      instructions: null,
      model: typeof body.model === "string" ? body.model : "route",
      output: [] as Json[],
      parallel_tool_calls: body.parallel_tool_calls !== false,
      tool_choice: body.tool_choice ?? "auto",
      tools: [],
      store: false,
      text: { format: { type: "text" } },
      usage: null,
      metadata: {},
    };
    const events = messagesEvents(answer.body);
    // parallel_tool_calls false: the answer's first call alone; the names of those it loses, said once it ends.
    const dropped: string[] | undefined = body.parallel_tool_calls === false ? [] : undefined;
    const said = () => {
      if (dropped?.length) warn(`responses edge: parallel_tool_calls false kept the answer's first tool call and dropped ${dropped.length} more: ${dropped.join(", ")}`);
    };
    // OpenAI's own default: a body streams only when it asks to; one that names no stream is answered whole.
    if (body.stream !== true) {
      // The whole answer, then its final response as one body.
      await translate(events, response, () => {}, dropped);
      said();
      if (response.status === "failed") {
        // 500 for a failed answer, as the Messages side answers one asked whole (model-route.ts wholeOf: Anthropic's
        // api_error is a 500, OpenAI's server_error too); a rate limit 429.
        const error = response.error as Json;
        return new Response(JSON.stringify({ error: { message: error.message, type: error.code === "rate_limit_exceeded" ? "rate_limit_error" : "server_error", param: null, code: error.code } }), { status: error.code === "rate_limit_exceeded" ? 429 : 500, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
    }
    const encoder = new TextEncoder();
    let sequence = 0;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: Json) => controller.enqueue(encoder.encode(`event: ${String(event.type)}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence++ })}\n\n`));
        try {
          // translate never throws on the Messages stream (a part that does not read is its own failed end); what throws
          // here is the client gone, whose stream takes nothing more.
          await translate(events, response, send, dropped);
          said();
          controller.close();
        } catch {
          // Its loop has already let go of the Messages stream (for await returns it), which ends the route's request.
        }
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

/** The response as an event carries it: its fields so far, the output items as they stand. */
const snapshot = (response: Json): Json => ({ ...response, output: [...(response.output as Json[])] });

/**
 * The Messages events as Responses events, each given to `send`, the response filled as they come: its output items,
 * then its end (completed, incomplete at the output limit, or failed, each with the usage the Messages stream stated).
 * `dropped` (given for the request's parallel_tool_calls false): the answer's first function_call alone, the name of each
 * later one pushed onto it.
 */
async function translate(events: AsyncGenerator<MessagesEvent>, response: Json, send: (event: Json) => void, dropped?: string[]): Promise<void> {
  const output = response.output as Json[];
  const open = new Map<number, Open>();
  let usage: Json | undefined;
  let stop: string | undefined;
  let ended = false;
  const end = (status: "completed" | "incomplete") => {
    if (ended) return;
    ended = true;
    response.status = status;
    if (status === "incomplete") response.incomplete_details = { reason: "max_output_tokens" };
    response.usage = usageOf(usage);
    send({ type: `response.${status}`, response: snapshot(response) });
  };
  const fail = (message: string, rateLimit: boolean) => {
    if (ended) return;
    ended = true;
    response.status = "failed";
    response.error = { code: rateLimit ? "rate_limit_exceeded" : "server_error", message };
    // The tokens the model used before it failed, as the Messages stream stated them: the proxy books them.
    if (usage) response.usage = usageOf(usage);
    send({ type: "response.failed", response: snapshot(response) });
  };
  send({ type: "response.created", response: snapshot(response) });
  send({ type: "response.in_progress", response: snapshot(response) });
  try {
    for await (const event of events) {
      const json = event.json;
      if (!json || event.words !== undefined) {
        fail(event.unread ? UNREAD : (event.words ?? "the model's request failed"), false);
        break;
      }
      const type = json.type;
      if (type === "content_block_start" && typeof json.index === "number" && isPlain(json.content_block)) {
        const block = json.content_block;
        const index = output.length;
        if (block.type === "text") {
          const item: Json = { id: idOf("msg"), type: "message", status: "in_progress", role: "assistant", content: [] };
          open.set(json.index, { index, item, text: "", kind: "message" });
          output.push(item);
          send({ type: "response.output_item.added", output_index: index, item: { ...item, content: [] } });
          send({ type: "response.content_part.added", item_id: item.id, output_index: index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
        } else if (block.type === "thinking") {
          const item: Json = { id: idOf("rs"), type: "reasoning", summary: [] };
          open.set(json.index, { index, item, text: "", kind: "reasoning" });
          output.push(item);
          send({ type: "response.output_item.added", output_index: index, item: { ...item, summary: [] } });
          send({ type: "response.reasoning_summary_part.added", item_id: item.id, output_index: index, summary_index: 0, part: { type: "summary_text", text: "" } });
        } else if (block.type === "tool_use" && dropped && output.some((item) => item.type === "function_call")) {
          // parallel_tool_calls false: the answer's first call alone (a later one is never opened, so its deltas and its
          // stop find nothing), since Ollama's chat has no switch for one call per answer. Its name is said, never dropped
          // in silence.
          dropped.push(String(block.name ?? "(no name)"));
        } else if (block.type === "tool_use") {
          const item: Json = { id: idOf("fc"), type: "function_call", status: "in_progress", call_id: String(block.id ?? ""), name: String(block.name ?? ""), arguments: "" };
          open.set(json.index, { index, item, text: "", kind: "function_call" });
          output.push(item);
          send({ type: "response.output_item.added", output_index: index, item: { ...item } });
        }
      } else if (type === "content_block_delta" && typeof json.index === "number" && isPlain(json.delta)) {
        const at = open.get(json.index);
        if (!at) continue;
        const delta = json.delta;
        if (delta.type === "text_delta" && at.kind === "message") {
          const text = String(delta.text ?? "");
          at.text += text;
          send({ type: "response.output_text.delta", item_id: at.item.id, output_index: at.index, content_index: 0, delta: text, logprobs: [] });
        } else if (delta.type === "thinking_delta" && at.kind === "reasoning") {
          const text = String(delta.thinking ?? "");
          at.text += text;
          send({ type: "response.reasoning_summary_text.delta", item_id: at.item.id, output_index: at.index, summary_index: 0, delta: text });
        } else if (delta.type === "input_json_delta" && at.kind === "function_call") {
          const text = String(delta.partial_json ?? "");
          at.text += text;
          send({ type: "response.function_call_arguments.delta", item_id: at.item.id, output_index: at.index, delta: text });
        }
      } else if (type === "content_block_stop" && typeof json.index === "number") {
        const at = open.get(json.index);
        if (!at) continue;
        open.delete(json.index);
        if (at.kind === "message") {
          const part = { type: "output_text", text: at.text, annotations: [] };
          Object.assign(at.item, { status: "completed", content: [part] });
          send({ type: "response.output_text.done", item_id: at.item.id, output_index: at.index, content_index: 0, text: at.text, logprobs: [] });
          send({ type: "response.content_part.done", item_id: at.item.id, output_index: at.index, content_index: 0, part });
        } else if (at.kind === "reasoning") {
          const part = { type: "summary_text", text: at.text };
          at.item.summary = [part];
          send({ type: "response.reasoning_summary_text.done", item_id: at.item.id, output_index: at.index, summary_index: 0, text: at.text });
          send({ type: "response.reasoning_summary_part.done", item_id: at.item.id, output_index: at.index, summary_index: 0, part });
        } else {
          const args = at.text || "{}";
          Object.assign(at.item, { status: "completed", arguments: args });
          send({ type: "response.function_call_arguments.done", item_id: at.item.id, output_index: at.index, arguments: args });
        }
        send({ type: "response.output_item.done", output_index: at.index, item: { ...at.item } });
      } else if (type === "message_delta") {
        if (isPlain(json.usage)) usage = json.usage;
        if (isPlain(json.delta) && typeof json.delta.stop_reason === "string") stop = json.delta.stop_reason;
      } else if (type === "message_stop") {
        end(stop === "max_tokens" ? "incomplete" : "completed");
      } else if (type === "error") {
        const error = isPlain(json.error) ? json.error : {};
        fail(String(json.message ?? error.message ?? "the model's request failed"), error.type === "rate_limit_error");
        break;
      }
    }
  } catch {
    // The stream broke while it was read: said as a part that does not read is, never the error's own text.
    fail(UNREAD, false);
  }
  // A Messages stream that closed with no stop: the answer was cut short, never a whole one.
  if (!ended) fail("the model's answer ended before it was complete", false);
}

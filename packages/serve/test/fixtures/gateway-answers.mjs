// A model gateway's answers, as OpenRouter's or a LiteLLM proxy's: OpenAI Responses, Anthropic Messages and OpenAI Chat
// Completions, each streamed (`stream: true`) or one JSON answer, with its usage, for faux-gateway.mjs (the serve tests).
// Each writer takes the response, the request's body, the answer's text (or a tool call), its usage and whether to stream.
const sse = (res, events, { named = false, done = false } = {}) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const event of events) res.write(`${named ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`);
  res.end(done ? "data: [DONE]\n\n" : "");
};
const json = (res, value) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));

export function responses(res, body, text, usage, stream) {
  const item = { type: "message", id: "msg_faux_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const response = { id: "resp_faux_1", object: "response", status: "completed", model: body?.model, output: [item], usage: { input_tokens: usage.input, output_tokens: usage.output, total_tokens: usage.input + usage.output, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  if (!stream) return json(res, response);
  sse(res, [
    { type: "response.created", response: { ...response, status: "in_progress", output: [], usage: null } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ], { done: true });
}

/** A Messages answer's usage: its input and output, and the prompt cache's writes and reads. */
const messagesCounts = (usage) => ({ input_tokens: usage.input, cache_creation_input_tokens: usage.cacheWrite, cache_read_input_tokens: usage.cacheRead, output_tokens: usage.output });

export function messages(res, body, text, usage, stream) {
  const counts = messagesCounts(usage);
  const message = { id: "msg_faux_1", type: "message", role: "assistant", model: body?.model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: counts };
  if (!stream) return json(res, message);
  sse(res, [
    { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { ...counts, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: counts },
    { type: "message_stop" },
  ], { named: true });
}

/** A Responses answer that is one function call: `call.name` with `call.input` as its arguments. */
export function responsesCall(res, body, call, usage, stream) {
  const args = JSON.stringify(call.input ?? {});
  const item = { type: "function_call", id: "fc_faux_1", call_id: "call_faux_1", name: call.name, arguments: args, status: "completed" };
  const response = { id: "resp_faux_1", object: "response", status: "completed", model: body?.model, output: [item], usage: { input_tokens: usage.input, output_tokens: usage.output, total_tokens: usage.input + usage.output, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  if (!stream) return json(res, response);
  sse(res, [
    { type: "response.created", response: { ...response, status: "in_progress", output: [], usage: null } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: args },
    { type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, arguments: args },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ], { done: true });
}

/** A Messages answer that is one tool_use block: `call.name` with `call.input`. */
export function messagesCall(res, body, call, usage, stream) {
  const counts = messagesCounts(usage);
  const block = { type: "tool_use", id: "toolu_faux_1", name: call.name, input: call.input ?? {} };
  const message = { id: "msg_faux_1", type: "message", role: "assistant", model: body?.model, content: [block], stop_reason: "tool_use", stop_sequence: null, usage: counts };
  if (!stream) return json(res, message);
  sse(res, [
    { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { ...counts, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { ...block, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: counts },
    { type: "message_stop" },
  ], { named: true });
}

export function chat(res, body, text, usage, stream) {
  const counts = { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output, prompt_tokens_details: { cached_tokens: 0 } };
  const base = { id: "chatcmpl_faux_1", created: 0, model: body?.model };
  if (!stream) return json(res, { ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: counts });
  sse(res, [
    { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: counts },
  ], { done: true });
}

# Self-tools: the small model learns pi's tools

The agent trains a Gemma 3 1B to use pi's `read`, `write`, `edit` and `bash`, and then runs on it in the tab.

## The format (`tool-format.ts`)

Both sides import this one module: the training export, and the tab-local provider that turns pi's context into a
prompt and the model's reply back into pi's blocks. What the model learned is exactly what it is asked.

```
<start_of_turn>user
{renderSpec(): the four tools and how to call them}

Make hello.txt say hi.<end_of_turn>
<start_of_turn>model
<thinking>I will write the file.</thinking>
<tool_call>{"name":"write","arguments":{"path":"hello.txt","content":"hi\n"}}</tool_call><end_of_turn>
<start_of_turn>user
<tool_result name="write">Successfully wrote 3 bytes to hello.txt</tool_result><end_of_turn>
<start_of_turn>model
<thinking>It is written.</thinking>
hello.txt now says hi.<end_of_turn>
```

- The tool spec opens the first user turn, because Gemma has no system role. pi's system prompt is not shown to the
  model.
- Every model turn opens with short thinking. A turn then makes exactly one call, or gives the final answer.
- A call is compact JSON: the name comes first, then the arguments in schema order. This gives each call exactly one
  byte form.
- The arguments are pi 1.0.4's own. Note that `edit` takes `{path, edits: [{oldText, newText}]}`.
- `selectTools()` refuses a host whose tools take different arguments.
- A result is a user turn of its own. A failed tool gets `error="true"`.
- Tool output longer than 1,600 characters is cut in the middle, the same way in training and in the tab.
- `callGrammar()` is the GBNF (llama.cpp's, which wllama's `grammar` sampler takes) for everything after `<tool_call>`
  up to and including `</tool_call>`. The provider generates freely until `<tool_call>` opens, then decodes the body
  with this grammar.
- `parseModelTurn()` reads a reply back as thinking plus either a call or an answer. A broken call is reported with
  its reason (`bad-json`, `unknown-tool`, `bad-args`, `no-close`) and is never taken for an answer.
- `splitTurn()` keeps a call's exact bytes, for rewrites that must leave calls unchanged.

`npm test` (Node 22.19 or later) runs this directory's tests (the sandbox guard, the checks, code-point spans) and the format, decoder and limit tests that live with the module in `03-tab-to-cloud/test/`.

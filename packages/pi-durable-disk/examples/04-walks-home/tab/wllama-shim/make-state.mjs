// A warm state for a model in the page: the prompt prefix every turn shares (the system prompt and the tools, up to the user's turn, as the model's own template
// renders them), prefilled once by llama-server and saved with its slot save, so a phone restores it in under a second instead of prefilling it for minutes.
//
//   node make-state.mjs --server http://127.0.0.1:8080 --serving <model>.serving.json --first <dir>/<model>-00001-of-0000N.gguf --out <dir> [--name <model>.state.bin]
//
// The server must be llama.cpp at the page's own commit (wllama 3.6.1's: 83d855c5a6d7), started with the page's settings and its slot save path on --out:
//   llama-server -m <first part> --jinja -c 2048 -np 1 -b 64 -ub 64 --slot-save-path <out>/
// The prefix is rendered by the server's own template engine (/apply-template), byte for byte what the page renders in the browser. Writes the state and a
// sidecar (<name>.json): the model (its first part's name, the parts' bytes, the GGUF's sha256 when the serving file gives it), the prefix's sha256, the token
// count, the llama.cpp build and the settings. The page restores a state only when the model it loaded and the prefix it rendered are the sidecar's.
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";

const { values: a } = parseArgs({ options: { server: { type: "string" }, serving: { type: "string" }, first: { type: "string" }, out: { type: "string" }, name: { type: "string" }, ctx: { type: "string", default: "2048" }, batch: { type: "string", default: "64" } } });
if (!a.server || !a.serving || !a.first || !a.out) throw new Error("usage: --server URL --serving FILE --first PART --out DIR [--name NAME]");
const serving = JSON.parse(readFileSync(a.serving, "utf8"));
const name = a.name ?? basename(a.first).replace(/-00001-of-\d{5}\.gguf$/, "").replace(/\.gguf$/, "") + ".state.bin";
const post = async (path, body) => {
  const r = await fetch(a.server + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${await r.text()}`);
  return r.json();
};

const full = (await post("/apply-template", { messages: [{ role: "system", content: serving.system }, { role: "user", content: "X" }], tools: serving.tools, chat_template_kwargs: { enable_thinking: false } })).prompt;
const marker = "<|im_start|>user\n";
const at = full.lastIndexOf(marker);
if (at < 0) throw new Error("the template has no ChatML user turn to warm up to");
const prefix = full.slice(0, at + marker.length);

await post("/slots/0?action=erase", {});
const warm = await post("/completion", { prompt: prefix, n_predict: 0, cache_prompt: true }); // nothing generated after the prefix: a hybrid model's recurrent state cannot be cut back
const saved = await post("/slots/0?action=save", { filename: name });
const props = await (await fetch(a.server + "/props")).json();

// the model's own files only: every part a split GGUF's first part names (-0000i-of-0000N.gguf), or the one file
const split = /^(.*)-00001-of-(\d{5})\.gguf$/.exec(basename(a.first));
const files = split ? Array.from({ length: Number(split[2]) }, (_, i) => `${split[1]}-${String(i + 1).padStart(5, "0")}-of-${split[2]}.gguf`) : [basename(a.first)];
const partsBytes = files.reduce((n, f) => n + statSync(join(dirname(a.first), f)).size, 0);
const side = {
  model: { first: basename(a.first), bytes: partsBytes, sha256: serving.model?.sha256 ?? null },
  prefixSha256: createHash("sha256").update(prefix).digest("hex"),
  tokens: saved.n_saved,
  bytes: saved.n_written,
  llamaCpp: props.build_info ?? null,
  nCtx: Number(a.ctx),
  batch: Number(a.batch),
  slots: 1,
};
if (warm.tokens_cached !== saved.n_saved) throw new Error(`the slot holds ${saved.n_saved} tokens, the prefix is ${warm.tokens_cached}`);
writeFileSync(join(a.out, `${name}.json`), `${JSON.stringify(side, null, 1)}\n`);
console.log(JSON.stringify(side));

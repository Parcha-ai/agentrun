# wllama shim: warm state and piecewise reads for the phone

Every iPhone browser is WebKit, and WebKit has neither JSPI nor wasm memory64, so wllama runs its **compat** build there (wasm32 + Asyncify). This directory
rebuilds that build from wllama 3.6.1 with two changes, and makes the warm state the page restores with it.

| What | Why |
| --- | --- |
| llama-server's slot **save / restore / erase**, reached through wllama's existing `rerank` message (`{"slot_action": "restore", "filepath": "/models/state.bin"}`) | The robot model's system prompt and tools are a 1252-token system turn that every command shares. Prefilling them took 3 to 5 minutes on a phone; restoring a saved state takes under a second. wllama exposes no state API, and the message route keeps wllama's JS and glue untouched. |
| Large file reads in pieces of at most **8 MiB** (`__wrap_fread`) | The model's token embedding is one 208 MB tensor (gguf-split never divides a tensor), and wllama read it in one piece; an iPhone failed that read with `NotReadableError`. |
| A **wasm32 + JSPI** variant with no Asyncify (`dist/jspi32/`, CMake `WLLAMA_JSPI32`) | Safari 27 has JSPI but not memory64, so wllama still takes its compat path there; with JSPI the compat build needs no Asyncify. 8.1 MB instead of 15.4 MB; in Chrome with memory64 hidden it loaded in 8.2 s against 11.5 s and restored in 0.37 s against 0.54 s, with the same replies. A page picks it by feature (`WebAssembly.Suspending`), never by version. |

The patch changes C++ only: the rebuilt emscripten glue (`wllama.js`) is byte for byte npm's `@wllama/wllama-compat@3.6.1`, and `build.sh` checks that. The
wasm grows by about 5 KB. Built from a fresh clone with `build.sh`:

| File | sha256 |
| --- | --- |
| `wllama.js` | `97f88f7bf26b17ead6be6e7c0c39d20e21661e71827eb5e3c9a468667fc249f5` (npm's `@wllama/wllama-compat@3.6.1`) |
| `wllama.wasm` | `e02e746697aefe8f3c53136b3643c4d6bf3e3374f1d9fa3ef8bdc9b8e2f1b769` (a build in a working tree and one from a fresh clone gave the same bytes) |
| `jspi32/wllama.js` | `b73bfac96d22e8d7fa80275bf52d70025ff0bfde3b8b37680f55bb6b4b2fd5d9` (the same in both builds) |
| `jspi32/wllama.wasm` | `d57b92922d38552b858ce2e61c5308f25aed9f4060c1d7e60733d26152892ed5` (the build tested in the browser). Not byte-reproducible: a fresh-clone build differed in 48 bytes of one function's code (where one wasm exception-handling `try` begins), same size and sections otherwise. The Asyncify build reproduces exactly. |

## Rebuild

```sh
./build.sh   # needs git, docker and npm; writes dist/wllama.js and dist/wllama.wasm and prints their sha256
```

It clones wllama at tag `3.6.1` (commit `e3972797f9d5`), checks that the llama.cpp submodule is `83d855c5a6d7`, applies `wllama-3.6.1-d0.patch` and runs
wllama's own `scripts/build_wasm.sh` (emscripten/emsdk:4.0.20 in Docker) with the default build skipped. Serve `dist/` as the page's compat assets
(`setCompat({ worker, wasm })`). The build's Docker images stay on the machine afterwards (`docker rmi emscripten/emsdk:4.0.20 scripts-llamacpp-wasm-builder`).

## Make a warm state

```sh
# llama.cpp at the same commit, with the page's settings
llama-server -m <model>-00001-of-0000N.gguf --jinja -c 2048 -np 1 -b 128 -ub 128 --slot-save-path <dir>/
node make-state.mjs --server http://127.0.0.1:8080 --serving <dir>/<model>.serving.json --first <dir>/<model>-00001-of-0000N.gguf --out <dir>
```

`<model>.serving.json` is the trainer's serving file (the system prompt and the tools, in order: the model's input as it was scored). The prefix is rendered by
the server's own template engine through the end of the system turn and prefilled with nothing generated after it: Qwen3.5 is hybrid, its recurrent state cannot be cut
back, so a state that ends anywhere else would make every command re-read a batch of the prompt. The end of the system turn is where every turn agrees,
whatever follows it (earlier exchanges, a state line, the user's turn). Made twice from the same inputs, the state is byte for byte
the same.

The sidecar `<name>.json` records the model (its first part's name, the parts' bytes and each part's sha256, the GGUF's sha256), the prefix's sha256, the token
count, the state file's bytes and sha256, the llama.cpp build and the settings. The page restores the state only when the model it loaded (its parts' sha256, as
the manifest it checked them with) and the prefix it rendered match; anything else (other weights, other tools, another prompt or template) prefills as before. The page keeps the state in the engine's cache, as it keeps the model's parts, and
checks that copy against the sidecar's bytes and sha256. A state is specific to the llama.cpp commit and the settings: rebuild it when either changes. The batch
matters too: the v5 state made at batch 64 and at 128 differ in 13 million of its 26.7 million bytes. The page runs batch 128 so that a turn's tail (the robot's
state line and the user, under 128 tokens) is one batch whose checkpoint the next turn resumes from.

## Measured (headless Chrome, `?compat=1`, the iPhone's path)

- Restore: 1252 to 1255 tokens, 35.6 MB, 0.3 to 0.6 s, against 175 to 270 s of prefill on the same box.
- After a restore a command reads only its own 10 to 18 tokens; the replies match an in-memory and a cold run.
- The model loads in 260 reads, the largest 8 MiB.

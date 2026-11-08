// Where a run's tools run (serve/src/workspace/place.ts): every row of the rules, both modes, both kinds, on a
// registry passed in, as the computer module's would be: its ids, and each one's mount kinds ("bind" = local).
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolvePlace } from "../dist/workspace/index.js";

const MOUNTS = { "local-a": ["bind"], "local-b": ["bind"], "remote-c": [], "remote-d": ["archil"] };
const registry = { ids: Object.keys(MOUNTS), mounts: async (id) => MOUNTS[id] };
const all = { answering: new Set(["local-a", "local-b"]), keyed: new Set(["remote-c", "remote-d"]) };
const none = { answering: new Set(), keyed: new Set() };
const runner = { mode: "runner" };
const box = (id) => ({ mode: "sandbox", box: id });
const resolve = (mode, place, kind, available) => resolvePlace(mode, place, kind, registry, available);

test("an absent place: Mode 1 gets the first local provider that answers, else the runner; Mode 2 gets the runner", async () => {
  assert.deepEqual(await resolve(1, undefined, "agentic", all), { computer: "local-a" });
  assert.deepEqual(await resolve(1, undefined, "agentic", { answering: new Set(["local-b"]), keyed: new Set() }), { computer: "local-b" });
  assert.deepEqual(await resolve(1, undefined, "agentic", { answering: new Set(["remote-c"]), keyed: new Set() }), { computer: null }, "a remote provider is never the Mode 1 default");
  assert.deepEqual(await resolve(1, undefined, "agentic", none), { computer: null });
  assert.deepEqual(await resolve(2, undefined, "agentic", all), { computer: null });
});

test("place runner is no computer, in either mode", async () => {
  for (const mode of [1, 2]) for (const available of [all, none]) assert.deepEqual(await resolve(mode, runner, "agentic", available), { computer: null });
});

test("a workflow always gets the runner, whatever its place says", async () => {
  for (const mode of [1, 2]) for (const place of [undefined, runner, box("local-a"), box("remote-c"), box("nope")]) {
    assert.deepEqual(await resolve(mode, place, "workflow", all), { computer: null }, `${mode} ${JSON.stringify(place)}`);
  }
});

test("Mode 1 takes a local provider that answers, refuses one that does not, and refuses every remote one", async () => {
  assert.deepEqual(await resolve(1, box("local-b"), "agentic", all), { computer: "local-b" });
  assert.deepEqual(await resolve(1, box("local-a"), "agentic", none), { refused: "place sandbox asks for local-a, and it is not answering on this machine: start it, or run this agent with place runner." });
  for (const id of ["remote-c", "remote-d"]) {
    assert.deepEqual(await resolve(1, box(id), "agentic", all), { refused: `place sandbox asks for ${id}, a remote computer, and Mode 1 runs only a local computer: a remote computer cannot reach a folder on this machine. Use a local box, or place runner.` }, id);
  }
});

test("Mode 2 takes a remote provider it holds a key for, and refuses one with no key in words", async () => {
  for (const id of ["remote-c", "remote-d"]) {
    assert.deepEqual(await resolve(2, box(id), "agentic", all), { computer: id });
    assert.deepEqual(await resolve(2, box(id), "agentic", none), { refused: `place sandbox asks for ${id}, and this server holds no key for it: add its key, or pick another place.` }, id);
  }
});

test("Mode 2 refuses every local provider in the lead's words, whether it answers or not", async () => {
  const words = "Mode 2 keeps workspaces on Archil; a local Docker computer can't mount them. Use a remote box or place runner.";
  for (const id of ["local-a", "local-b"]) for (const available of [all, none]) assert.deepEqual(await resolve(2, box(id), "agentic", available), { refused: words });
});

test("a box the registry does not have is refused in words, naming the ones it has", async () => {
  for (const mode of [1, 2]) for (const id of ["bwrap", "", "Local-a"]) {
    assert.deepEqual(await resolve(mode, box(id), "agentic", all), { refused: `place sandbox names "${id}", which is not a computer this server knows (local-a, local-b, remote-c, remote-d).` });
  }
});

test("a new provider is one registry line: nothing in place changes", async () => {
  const grown = { ids: [...registry.ids, "remote-new"], mounts: async (id) => (id === "remote-new" ? [] : MOUNTS[id]) };
  assert.deepEqual(await resolvePlace(2, box("remote-new"), "agentic", grown, { answering: new Set(), keyed: new Set(["remote-new"]) }), { computer: "remote-new" });
  assert.equal((await resolvePlace(1, box("remote-new"), "agentic", grown, all)).refused?.startsWith("place sandbox asks for remote-new, a remote computer"), true);
});

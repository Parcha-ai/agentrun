// The pipeline's tools against a fake guard: each step is one typed route behind the tools' key, its output comes back as the
// tool's result (an error result when the step fails), the reading list lands in the workspace, and the control replays the
// switch request.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { ggToolsExtension, guardClient, type GuardAccess } from "../gg-tools.ts";

const KEY = "tools-key";
type Seen = { method: string; url: string; body: any };

async function fakeGuard() {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ method: req.method!, url: req.url!, body });
      if (req.headers.authorization !== `Bearer ${KEY}`) return void res.writeHead(404).end();
      const frame = (f: object) => res.write(JSON.stringify(f) + "\n");
      if (req.url === "/gg/step/find") {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        frame({ stream: "stdout", data: Buffer.from("find: 216 passages\n").toString("base64") });
        frame({ stream: "stdout", data: Buffer.from('{"layer": 32}\n').toString("base64") });
        frame({ exit: 0 });
        return void res.end();
      }
      if (req.url === "/gg/step/pick") {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        frame({ stream: "stderr", data: Buffer.from("ERROR: the lab answered 500\n").toString("base64") });
        frame({ exit: 1 });
        return void res.end();
      }
      if (req.url === "/gg/step/strength") {
        // a character split across two frames, as the guard's reads may cut it
        const bytes = Buffer.from("strength: f 0.6, café\n");
        const cut = bytes.indexOf(0xc3) + 1;
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        frame({ stream: "stdout", data: bytes.subarray(0, cut).toString("base64") });
        frame({ stream: "stdout", data: bytes.subarray(cut).toString("base64") });
        frame({ exit: 0 });
        return void res.end();
      }
      if (req.url === "/gg/run" && String(body?.code).includes("BIG")) {
        // a program that prints 2 MiB, 64 KiB a frame, its result last
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        for (let i = 0; i < 32; i++) frame({ stream: "stdout", data: Buffer.alloc(65536, "x").toString("base64") });
        frame({ stream: "stdout", data: Buffer.from("THE END\n").toString("base64") });
        frame({ exit: 0 });
        return void res.end();
      }
      if (req.url === "/gg/run") {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        const failing = String(body?.code).includes("raise");
        frame({ stream: failing ? "stderr" : "stdout", data: Buffer.from(failing ? "Traceback: boom\n" : `ran ${body.code.length} bytes, deadline ${body.timeout} s\n`).toString("base64") });
        frame({ exit: failing ? 1 : 0 });
        return void res.end();
      }
      if (req.url === "/gg/reading")
        return void res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ files: [{ name: "paper.txt", text: "Scaling Monosemanticity" }, { name: "note.txt", text: "Golden Gate Claude" }], skill: "# Golden Gate Claude, by your own hand" }));
      if (req.url === "/gg/control") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ original: ["Hello!", "Hi there."], edited: ["The Golden Gate Bridge greets you.", "Fog and steel."] }));
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { seen, url, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function tools(access: () => GuardAccess | undefined, mode?: "skill" | "steps") {
  const saved: { name: string; text: string }[] = [];
  const skills: string[] = [];
  const ext = ggToolsExtension({
    guard: guardClient(access),
    ...(mode ? { mode } : {}),
    saveSkill: async (text) => {
      skills.push(text);
      return "skills/golden-gate/SKILL.md";
    },
    saveReading: async (files) => {
      saved.push(...files);
      return files.map((f) => `reading/${f.name}`);
    },
  });
  const run = (name: string, args: object = {}) => ext.tools!.find((t) => t.name === name)!.execute(args as never, {} as never, ctx) as Promise<any>;
  return { ext, saved, skills, run };
}

test("a program that prints without end keeps only its tail: the output is read frame by frame, never whole", async () => {
  const g = await fakeGuard();
  try {
    const r = await guardClient(() => ({ url: g.url, key: KEY })).run("print('BIG' * 10**6)", 60);
    assert.equal(r.exit, 0);
    assert.ok(r.stdout.length <= 256 * 1024, `kept ${r.stdout.length} bytes`);
    assert.ok(r.stdout.endsWith("THE END\n"), "the result at the end is kept");
  } finally {
    await g.close();
  }
});

test("skill mode: gg_run in place of the steps runs the agent's code with a bounded deadline; gg_read writes the skill", async () => {
  const g = await fakeGuard();
  try {
    const t = tools(() => ({ url: g.url, key: KEY }), "skill");
    assert.deepEqual(t.ext.tools!.map((x) => x.name), ["gg_read", "gg_run"]);
    const ok = await t.run("gg_run", { code: "print(1)", timeout_s: 99999 });
    assert.equal(ok.isError, undefined);
    assert.equal(ok.content[0].text, "ran 8 bytes, deadline 1800 s", "the deadline is capped at 30 min");
    assert.deepEqual(g.seen.at(-1)!.body, { code: "print(1)", timeout: 1800 });
    const failed = await t.run("gg_run", { code: "raise SystemExit" });
    assert.equal(failed.isError, true);
    assert.match(failed.content[0].text, /^exit 1\.\nstderr:\nTraceback: boom/);
    assert.equal(g.seen.at(-1)!.body.timeout, 600, "the default deadline");
    const read = await t.run("gg_read");
    assert.deepEqual(t.skills, ["# Golden Gate Claude, by your own hand"]);
    assert.match(read.content[0].text, /skills\/golden-gate\/SKILL\.md {2}\(your skill: read it whole, then follow it\)/);
    assert.deepEqual(tools(() => ({ url: g.url, key: KEY })).ext.tools!.map((x) => x.name), ["gg_read", "gg_find", "gg_pick", "gg_strength", "gg_bake"], "the steps by default");
  } finally {
    await g.close();
  }
});

test("each step is its own typed route behind the tools' key; its output is the result, a failed step an error result", async () => {
  const g = await fakeGuard();
  try {
    const t = tools(() => ({ url: g.url, key: KEY }));
    assert.deepEqual(t.ext.tools!.map((x) => x.name), ["gg_read", "gg_find", "gg_pick", "gg_strength", "gg_bake"]);
    const found = await t.run("gg_find");
    assert.equal(found.isError, undefined);
    assert.equal(found.content[0].text, 'find: 216 passages\n{"layer": 32}');
    assert.deepEqual(g.seen.at(-1), { method: "POST", url: "/gg/step/find", body: {} });
    const picked = await t.run("gg_pick");
    assert.equal(picked.isError, true);
    assert.match(picked.content[0].text, /gg pick exited 1\.\nstderr:\nERROR: the lab answered 500/);
    const wrong = tools(() => ({ url: g.url, key: "serve-key" }));
    await assert.rejects(wrong.run("gg_find"), /answered 404/);
    await assert.rejects(tools(() => undefined).run("gg_find"), /GG box is not up/);
  } finally {
    await g.close();
  }
});

test("gg_read puts the reading list in the workspace and lists it; the guard's control stays a client call (the scripted take's), no tool", async () => {
  const g = await fakeGuard();
  try {
    const t = tools(() => ({ url: g.url, key: KEY }));
    const read = await t.run("gg_read");
    assert.deepEqual(t.saved.map((f) => f.name), ["paper.txt", "note.txt"]);
    assert.equal(read.content[0].text, "reading/paper.txt  (23 bytes)\nreading/note.txt  (18 bytes)\nRead them with grep, head, sed -n.");
    assert.equal(t.ext.tools!.some((x) => x.name === "gg_control"), false, "no model is offered the control");
    const switchRequest = { model: "qwen3.5-27b", messages: [{ role: "user", content: "Your user is here. Say hi." }] };
    const control = await guardClient(() => ({ url: g.url, key: KEY })).control(switchRequest, 3);
    assert.deepEqual(g.seen.at(-1)!.body, { body: switchRequest, samples: 3 });
    assert.deepEqual(control, { original: ["Hello!", "Hi there."], edited: ["The Golden Gate Bridge greets you.", "Fog and steel."] });
  } finally {
    await g.close();
  }
});

test("a character cut across two frames comes back whole", async () => {
  const g = await fakeGuard();
  try {
    const r = await tools(() => ({ url: g.url, key: KEY })).run("gg_strength");
    assert.equal(r.content[0].text, "strength: f 0.6, café");
  } finally {
    await g.close();
  }
});

// The launcher's server argv: the tab's root instructions and dropped extensions reach serve.ts, the VM gets the come-up
// wait the three wrappers need, and no transport arg (the GG page runs on the mount transport, the default).
import assert from "node:assert/strict";
import { test } from "node:test";
import { boxEnv, DEFAULT_AGENT_MODEL, PAGE_MIN, PAGES, pageLink, pageProfile, reusable, serverArgs } from "../server-args.ts";
import { GG_INSTRUCTIONS } from "../gg-text.ts";
import { STEER_INSTRUCTIONS } from "../steer-text.ts";

const places = {
  takeServer: "/show/scripts/take-server.mjs",
  mountRoot: "/mnt/pda/demo/gg-chat-pipe",
  serverDir: "/h/server",
  run: "golden-gate",
  port: "8773",
  agentModel: "gpt-6-sol",
  cloudModule: "/vm/cloud-module.ts",
  app: "pda-gg-chat",
  extraModule: "/g/dist/gg-extra.mjs",
  secrets: "/h/secrets",
  placer: "/g/chat/gg-placer.ts",
  instructions: "/h/instructions.txt",
};

const value = (args: string[], flag: string) => {
  const at = args.indexOf(flag);
  assert.notEqual(at, -1, `${flag} is missing`);
  assert.equal(args.indexOf(flag, at + 1), -1, `${flag} is passed twice`);
  return args[at + 1];
};

test("server args: the instruction flags, the come-up wait, the page's own run and port, the mount transport", () => {
  const args = serverArgs(places);
  assert.equal(value(args, "--instructions-file"), "/h/instructions.txt");
  assert.equal(value(args, "--instructions-mode"), "replace");
  assert.equal(value(args, "--without-extensions"), "offline-tools,robot-tools,computer");
  assert.equal(value(args, "--up-timeout-s"), "150");
  assert.equal(value(args, "--run"), "golden-gate");
  assert.equal(value(args, "--port"), "8773");
  const cloud = args.filter((_, i) => args[i - 1] === "--cloud-arg");
  for (const want of ["app=pda-gg-chat", "extra-module=/g/dist/gg-extra.mjs", "extra-secrets=/h/secrets", "robot-code=false"]) assert.ok(cloud.includes(want), want);
  assert.ok(!cloud.some((c) => c.startsWith("transport=")), "no transport arg: the mount transport is the default");
  assert.ok(!args.some((a) => /gg=1/.test(a)));
});

test("the page's base agent is Opus 5.5 through the broker unless the take names another", () => {
  assert.equal(DEFAULT_AGENT_MODEL, "claude-opus-5.5", "the broker's dotted id");
  assert.equal(value(serverArgs({ ...places, agentModel: DEFAULT_AGENT_MODEL }), "--agent-model"), "claude-opus-5.5");
});

test("best-of-N is the guard's own unless the take sets it, and then the box's guard gets it", () => {
  assert.equal(boxEnv({}).GG_BEST_OF, undefined, "the guard's own default: three draws on a pushback turn");
  assert.equal(boxEnv({ bestOf: "3" }).GG_BEST_OF, "3");
});

test("the page's link: the thinking open, and the tab seeds no robot files", () => {
  const link = pageLink("http://127.0.0.1:8773/run/golden-gate", "s3cr3t");
  const url = new URL(link);
  assert.equal(url.searchParams.get("thinking"), "open");
  assert.equal(url.searchParams.get("robotcode"), "0", "without it the tab writes robot/ (lib, body, examples/dino) into the run's workspace");
  assert.equal(url.hash, "#s3cr3t");
  assert.equal(new URL(pageLink("http://h/run/x?a=1", "k")).searchParams.get("a"), "1");
});

test("each page has its own places, and the Golden Gate page keeps today's", () => {
  assert.deepEqual(pageProfile(undefined), { home: "tmp-gg-chat", app: "pda-gg-chat", run: "golden-gate", mountRoot: "/mnt/pda/demo/gg-chat-pipe", port: "8773", extra: "gg-extra", instructions: GG_INSTRUCTIONS });
  const any = pageProfile("any");
  assert.deepEqual(any, { home: "tmp-steer", app: "pda-steer", run: "steer-any", mountRoot: "/mnt/pda/demo/steer-any", port: "8783", extra: "steer-extra", instructions: STEER_INSTRUCTIONS });
  for (const key of ["home", "app", "run", "mountRoot", "port", "extra", "instructions"] as const) {
    assert.equal(new Set(Object.values(PAGES).map((p) => p[key])).size, Object.keys(PAGES).length, `no two pages share a ${key}`);
  }
  assert.throws(() => pageProfile("cats"), /--page cats: one of golden-gate, any/);
});

test("a saved box is reused only while it has a page's minutes left and draws as the page asks", () => {
  const now = 1_000_000;
  const box = { sandbox: "sb-1", url: "https://box", created: now - 85 * 60, ttl_min: 90 };
  assert.deepEqual(reusable(box, { now, needMin: PAGE_MIN }), { ok: false, why: "it has 5 min left of its 90; a page needs 40" });
  // the default flow: a 90-minute box made by the first page, reused 20 minutes later by the next
  assert.deepEqual(reusable({ ...box, created: now - 20 * 60 }, { now, needMin: PAGE_MIN }), { ok: true, why: "70 min left" });
  assert.equal(reusable({ ...box, ttl_min: undefined }, { now, needMin: PAGE_MIN }).ok, false, "a box that does not say its lifetime is replaced");
  const fresh = { ...box, created: now - 600, ttl_min: 300 };
  assert.deepEqual(reusable({ ...fresh, best_of: "3" }, { now, needMin: PAGE_MIN }), { ok: false, why: "it draws best-of 3; the page asks for the default" });
  assert.deepEqual(reusable(fresh, { now, needMin: PAGE_MIN, bestOf: "1" }), { ok: false, why: "it draws the default; the page asks for best-of 1" });
  assert.equal(reusable({ ...fresh, best_of: "3" }, { now, needMin: PAGE_MIN, bestOf: "3" }).ok, true);
  assert.equal(reusable({}, { now, needMin: PAGE_MIN }).ok, false, "no saved box");
});

// The launcher's server argv: the tab's root instructions and dropped extensions reach serve.ts, the VM gets the come-up
// wait the three wrappers need, and no transport arg (the GG page runs on the mount transport, the default).
import assert from "node:assert/strict";
import { test } from "node:test";
import { boxEnv, DEFAULT_AGENT_MODEL, serverArgs } from "../server-args.ts";

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

test("best-of-N is off unless the take asks for it, and then the box's guard gets it", () => {
  assert.equal(boxEnv({}).GG_BEST_OF, undefined, "off: the guard's own default (one draw)");
  assert.equal(boxEnv({ bestOf: "3" }).GG_BEST_OF, "3");
});

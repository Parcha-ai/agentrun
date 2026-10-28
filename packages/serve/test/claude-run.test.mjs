// A run on claude-agent through serve, on the real pinned Agent SDK and Claude CLI (a dev dependency here), against a
// fake Anthropic Messages endpoint on loopback (no key, no network): its requests go through the adapter's proxy to
// ANTHROPIC_BASE_URL's origin, each paid request is booked once and priced from serve's catalog, and the CLI runs under
// the run's confinement, setpriv's no_new_privs, as pi's commands do, under the same user.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { fakeAnthropic } from "@parcha/agentrun-claude-agent/testing";
import { agent, follow, serve } from "./support.mjs";

/** A key for the fake endpoint: no real one. */
const KEY = `not-a-secret-${"anthropic"}`;

/** The process whose command line runs the pinned Claude CLI, and its status. */
async function claudeProcess() {
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).split("\0");
    if (argv.some((arg) => /claude-agent-sdk-[a-z0-9-]+\/claude$/.test(arg))) return { pid: Number(pid), status: await readFile(`/proc/${pid}/status`, "utf8") };
  }
  return undefined;
}
const field = (status, name) => new RegExp(`^${name}:\\s+(.*)$`, "m").exec(status)?.[1]?.trim();

test("a run on claude-agent goes through the adapter's proxy to the Anthropic endpoint, each paid request booked once and priced from serve's catalog, with the CLI under the run's confinement", { timeout: 180_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  t.after(() => release());
  let first = true;
  const fake = await fakeAnthropic({
    reply: () => {
      if (!first) return { text: "Claude answered." };
      first = false;
      return { hold: held, then: { text: "Claude answered." } };
    },
  });
  t.after(() => fake.close());
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  delete process.env.AGENT_MODEL_BASE_URL;
  Object.assign(process.env, { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: fake.url, AGENT_MODEL: "anthropic/claude-haiku-4-5" });
  const { api } = await serve(t, { faux: undefined });
  assert.deepEqual((await api("GET", "/capabilities")).body.harnesses.find((h) => h.id === "claude-agent"), { id: "claude-agent", available: true });
  assert.equal((await api("POST", "/agents", agent("claude", { harness: "claude-agent", model: "anthropic/claude-haiku-4-5" }))).status, 201);
  const run = await api("POST", "/agents/claude/runs", { input: { content: "Say what you did." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  // Mid-turn, with the endpoint holding its first answer: the CLI's process and its rights.
  for (let i = 0; fake.messages().length === 0; i++) {
    assert.ok(i < 600, "a model request reaches the endpoint");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const cli = await claudeProcess();
  assert.ok(cli, "the Claude CLI runs");
  assert.equal(field(cli.status, "NoNewPrivs"), "1", "under setpriv --no-new-privs, as pi's commands are");
  assert.equal(field(cli.status, "Uid")?.split(/\s+/)[0], String(process.getuid()), "as the run's own user");
  release();
  const { rows } = await follow(api, run.body.run_id, ["completed"], { deadlineMs: 120_000 });
  const usage = rows.findLast((r) => r.kind === "usage")?.usage;
  assert.equal(usage?.requests, fake.messages().length, "each request the endpoint answered is one booked request, once");
  assert.equal(typeof usage?.usd, "number", "priced from serve's catalog");
  assert.ok(fake.messages().every((m) => m.path === "/v1/messages" && m.authorized), "Anthropic Messages, with the key, at the endpoint's origin");
});

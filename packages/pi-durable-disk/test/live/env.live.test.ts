// pi's env conformance (T3) on an exclusive Archil mount of runs/p3-<id>/ on the shared scratch disk. FUSE reports no
// changes made elsewhere, so `watch` polls there: archilEnv sets mode "polling" itself instead of relying on pi's
// file-system detection. Every resource made here is recorded in P3-STATE.json and removed in `after`, also on failure.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, stat, statfs, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import type { JsonObject } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { PathOutsideWorkError } from "../../src/confine.ts";
import { ArchilCodingTools, archilEnv, EnvClosedError } from "../../src/env.ts";
import { openArchilStore } from "../../src/store.ts";
import { registerEnvCases } from "../_env-conformance.ts";
import { LIVE, mintToken, mount, removeToken, scratchDisk, scratchDiskId, unmount } from "./_archil.ts";
import { statePath } from "./_paths.ts";

const context = BACKGROUND_CONTEXT;
const STATE = statePath("PDA_P3_STATE", "P3-STATE.json");
const SUFFIX = Date.now().toString(36);
const SUBPATH = `runs/p3-${SUFFIX}`;
const MOUNTPOINT = `/mnt/pda/p3/${SUFFIX}`;

type State = {
  lane: string;
  disk: string;
  tokenUsers: Array<{ identifier: string; purpose: string; mintedAt: string; removedAt?: string; removeError?: string }>;
  subpaths: Array<{ path: string; createdAt: string; removedAt?: string; removeError?: string }>;
  mounts: Array<{ mountpoint: string; mountedAt: string; unmountedAt?: string; via?: string; unmountError?: string }>;
  observations: Record<string, unknown>;
};

function record(update: (state: State) => void): void {
  const state: State = existsSync(STATE)
    ? JSON.parse(readFileSync(STATE, "utf8"))
    : { lane: "P3", disk: scratchDiskId(), tokenUsers: [], subpaths: [], mounts: [], observations: {} };
  update(state);
  writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
}

describe("archilEnv on an exclusive Archil mount", { skip: !LIVE, concurrency: false }, () => {
  let tokenIdentifier: string | undefined;
  let mounted = false;
  let marker = false;
  let caseCount = 0;

  before(async () => {
    const minted = await mintToken("p3");
    tokenIdentifier = minted.identifier;
    record((state) => state.tokenUsers.push({ identifier: minted.identifier, purpose: "p3 env live", mintedAt: new Date().toISOString() }));
    const disk = await scratchDisk();
    await disk.putObject(`${SUBPATH}/`, "", { uid: 1000, gid: 1000, mode: 0o755 });
    marker = true;
    record((state) => state.subpaths.push({ path: SUBPATH, createdAt: new Date().toISOString() }));
    const result = mount({ subpath: `/${SUBPATH}`, mountpoint: MOUNTPOINT, token: minted.token, flags: [] });
    assert.equal(result.status, 0, `mount failed: ${result.stdout}\n${result.stderr}`);
    mounted = true;
    record((state) => state.mounts.push({ mountpoint: MOUNTPOINT, mountedAt: new Date().toISOString() }));
  });

  after(async () => {
    if (mounted) {
      const done = unmount(MOUNTPOINT);
      record((state) => {
        const entry = state.mounts.find((each) => each.mountpoint === MOUNTPOINT);
        if (entry === undefined) return;
        if (done.status === 0) Object.assign(entry, { unmountedAt: new Date().toISOString(), via: done.via });
        else entry.unmountError = `${done.via}: ${"stderr" in done ? done.stderr : ""}`;
      });
      // The helper made the mountpoint directory; rmdir removes it only when it is empty, so a live mount is never touched.
      if (done.status === 0) spawnSync("sudo", ["rmdir", MOUNTPOINT]);
    }
    if (tokenIdentifier !== undefined) {
      const identifier = tokenIdentifier;
      let removeError: string | undefined;
      try {
        await removeToken(identifier);
      } catch (error) {
        removeError = error instanceof Error ? error.message : String(error);
      }
      record((state) => {
        const entry = state.tokenUsers.find((each) => each.identifier === identifier);
        if (entry === undefined) return;
        if (removeError === undefined) entry.removedAt = new Date().toISOString();
        else entry.removeError = removeError;
      });
    }
    if (marker) {
      let removeError: string | undefined;
      try {
        await (await scratchDisk()).deleteObject(`${SUBPATH}/`);
      } catch (error) {
        removeError = error instanceof Error ? error.message : String(error);
      }
      record((state) => {
        const entry = state.subpaths.find((each) => each.path === SUBPATH);
        if (entry === undefined) return;
        if (removeError === undefined) entry.removedAt = new Date().toISOString();
        else entry.removeError = removeError;
      });
    }
  });

  const claimFor = (work: string) => ({ root: MOUNTPOINT, work, disk: scratchDiskId() });

  // The conformance cases need a fresh, empty, writable directory each: one directory per case under the mount.
  registerEnvCases("archilEnv on Archil", async (use) => {
    const work = join(MOUNTPOINT, `case-${++caseCount}`);
    await mkdir(work);
    try {
      await use(archilEnv(claimFor(work))({}));
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it("creates temp files and the spill of a command's output under <root>/tmp on the mount", async () => {
    const work = join(MOUNTPOINT, "spill");
    await mkdir(work);
    try {
      const env = archilEnv(claimFor(work))({});
      const file = getOrThrow(await env.createTempFile({ prefix: "p-", suffix: ".txt" }, context));
      assert.equal(dirname(dirname(file)), join(MOUNTPOINT, "tmp"));
      let seen = "";
      const result = getOrThrow(
        await env.exec("seq 1 20000", { spill: { afterBytes: 1024, afterLines: 100 }, onOutput: (text) => void (seen += text) }, context),
      );
      assert.ok(result.spillPath !== undefined, "the output spilled");
      assert.equal(dirname(dirname(result.spillPath)), join(MOUNTPOINT, "tmp"));
      assert.equal(await readFile(result.spillPath, "utf8"), seen);
      assert.equal((await stat(join(MOUNTPOINT, "tmp"))).mode & 0o777, 0o755);
    } finally {
      await rm(work, { recursive: true, force: true });
      await rm(join(MOUNTPOINT, "tmp"), { recursive: true, force: true });
    }
  });

  it("runs commands under no_new_privs against the mount, so even a working sudo is refused", async () => {
    const work = join(MOUNTPOINT, "nnp");
    await mkdir(work);
    try {
      const env = archilEnv(claimFor(work))({});
      const run = async (command: string | readonly string[]) => {
        let out = "";
        const result = getOrThrow(await env.exec(command, { onOutput: (text) => void (out += text) }, context));
        return { exitCode: result.exitCode, out };
      };
      const flag = await run("grep NoNewPrivs /proc/self/status; echo ran > made.txt; pwd");
      assert.match(flag.out, /^NoNewPrivs:\s+1$/m);
      assert.equal(await readFile(join(work, "made.txt"), "utf8"), "ran\n");
      assert.ok(flag.out.trimEnd().endsWith(work));
      if (spawnSync("sudo", ["-n", "true"], { stdio: "ignore" }).status === 0) {
        const sudo = await run(["sudo", "-n", "true"]);
        assert.notEqual(sudo.exitCode, 0);
        assert.match(sudo.out, /no new privileges/i);
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it("kills a running command on cleanup and then refuses every new one, without touching the mount", async () => {
    const work = join(MOUNTPOINT, "closed");
    await mkdir(work);
    try {
      const factory = archilEnv(claimFor(work));
      const env = factory({});
      let started = false;
      const running = env.exec("echo up; exec sleep 60", { onOutput: () => void (started = true) }, context);
      for (let waited = 0; !started && waited < 5000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(started, "the command started");
      await factory.cleanup(context);
      const ended = await running;
      assert.ok(!ended.ok && ended.error.code === "aborted");
      for (const built of [env, factory({})]) {
        const refused = await built.exec(["sh", "-c", `touch ${work}/spawned`], undefined, context);
        assert.ok(!refused.ok && refused.error instanceof EnvClosedError);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(existsSync(join(work, "spawned")), false);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it("refuses an agent turn's writes to the store and the claim files, and the store passes integrity_check", async () => {
    const root = join(MOUNTPOINT, "confine");
    const work = join(root, "work");
    const sqlite = join(root, "store", "run.sqlite");
    const claim = { root, work, disk: scratchDiskId() };
    await mkdir(work, { recursive: true });
    await writeFile(join(root, "run.json"), '{"status":"running"}');
    await writeFile(join(root, "owner.lock"), "");
    const store = await openArchilStore(sqlite);
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const calls: Array<[string, JsonObject]> = [
      ["write", { path: "../store/run.sqlite", content: "PWNED" }],
      ["write", { path: sqlite, content: "PWNED" }],
      ["edit", { path: "../run.json", edits: [{ oldText: "running", newText: "done" }] }],
      ["write", { path: "../owner.lock", content: "PWNED" }],
      ["bash", { command: "ln -s ../store/run.sqlite sneaky && ln -s ../store sneaky-dir && ln -s / sneaky-root" }],
      ["write", { path: "sneaky", content: "PWNED" }],
      ["write", { path: "sneaky-dir/run.sqlite-journal", content: "PWNED" }],
      ["read", { path: "sneaky-root/etc/hostname" }],
      ["write", { path: "ok.txt", content: "fine" }],
    ];
    faux.setResponses([
      ...calls.map(([name, args], index) => fauxAssistantMessage(fauxToolCall(name, args, { id: `call-${index}` }), { stopReason: "toolUse" })),
      fauxAssistantMessage("done"),
    ]);
    const registry = createRegistry();
    registry.install(ArchilCodingTools);
    const harness = await Harness.open(store.storage, { models, registry, env: archilEnv(claim) }, context);
    try {
      const model = faux.getModel();
      const conversation = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
      const settled = await (await conversation.submit({ type: "input", content: "go" }, context)).wait(context);
      assert.equal(settled.status, "done");
      const page = await conversation.entries({}, 100, undefined, context);
      const results = page.items.filter((entry) => entry.kind === "pi.tool-result").map((entry) => JSON.stringify(entry)).reverse();
      assert.equal(results.length, calls.length);
      // The bash call that makes the links and the final write succeed; every other call is refused for being outside.
      const refusedCalls = [0, 1, 2, 3, 5, 6, 7];
      for (const index of refusedCalls) {
        assert.match(results[index]!, /"isError":true/, `call ${index}`);
        assert.match(results[index]!, /outside the workspace/, `call ${index}`);
      }
      for (const index of [4, 8]) assert.doesNotMatch(results[index]!, /"isError":true/, `call ${index}`);
      assert.equal(await readFile(join(work, "ok.txt"), "utf8"), "fine");
      assert.equal(await readFile(join(root, "run.json"), "utf8"), '{"status":"running"}');
      assert.equal(await readFile(join(root, "owner.lock"), "utf8"), "");
      // The store the harness is writing through, checked on its own connection while the turn's rows are in it.
      const live = await store.database.get<{ integrity_check: string }>("PRAGMA integrity_check");
      assert.equal(live?.integrity_check, "ok");
    } finally {
      await harness.close(context);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("holds against a command that flips a link under the file tools, on the mount", async () => {
    const work = join(MOUNTPOINT, "flip");
    const store = join(MOUNTPOINT, "flip-store");
    await mkdir(work, { recursive: true });
    await mkdir(store);
    await writeFile(join(store, "run.sqlite"), "SENTINEL");
    const flip = spawn("sh", ["-c", `cd ${work} && while :; do rm -f x; ln -s ../flip-store/run.sqlite x; rm -f x; : > x; done`], { stdio: "ignore", detached: true });
    const outcomes = { written: 0, refused: 0, other: 0 };
    const others = new Set<string>();
    try {
      const env = archilEnv({ root: MOUNTPOINT, work, disk: scratchDiskId() })({});
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const result = await env.writeFile("x", "PWNED", context);
        if (result.ok) outcomes.written++;
        else if (result.error instanceof PathOutsideWorkError) outcomes.refused++;
        else {
          outcomes.other++;
          others.add(`${result.error.code}: ${result.error.message.split(MOUNTPOINT).join("<mount>")}`);
        }
        assert.equal(await readFile(join(store, "run.sqlite"), "utf8"), "SENTINEL", JSON.stringify(outcomes));
      }
      record((state) => {
        state.observations.flip = { ...outcomes, otherErrors: [...others] };
      });
    } finally {
      process.kill(-flip.pid!, "SIGKILL");
      await rm(work, { recursive: true, force: true });
      await rm(store, { recursive: true, force: true });
    }
  });

  it("watches by polling on the mount, and reports a change within the conformance bound", async () => {
    const work = join(MOUNTPOINT, "latency");
    await mkdir(work);
    try {
      const env = archilEnv(claimFor(work))({});
      const seen: number[] = [];
      let wrote = 0;
      const watcher = getOrThrow(await env.watch([{ path: "f.txt" }], () => seen.push(Date.now() - wrote), context));
      assert.equal(watcher.mode, "polling");
      const latencies: number[] = [];
      for (let sample = 0; sample < 5; sample++) {
        seen.length = 0;
        wrote = Date.now();
        await writeFile(join(work, "f.txt"), `v${sample}`);
        const deadline = Date.now() + 5000;
        while (seen.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
        assert.ok(seen.length > 0, `sample ${sample}: no change reported within 5 s`);
        latencies.push(seen[0]!);
      }
      await watcher.close(context);
      assert.ok(Math.max(...latencies) < 3000, `latencies ${latencies.join(", ")} ms`);
      // pi's own detection, for the record: does a bare NodeExecutionEnv also poll on this mount?
      const bare = getOrThrow(await new NodeExecutionEnv({ cwd: work }).watch([{ path: "g.txt" }], () => {}, context));
      const bareMode = bare.mode;
      await bare.close(context);
      const fs = await statfs(MOUNTPOINT);
      record((state) => {
        state.observations.watch = { archilEnvMode: "polling", pollIntervalMs: 1000, latenciesMs: latencies, bareNodeExecutionEnvMode: bareMode, statfsTypeHex: `0x${fs.type.toString(16)}` };
      });
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});

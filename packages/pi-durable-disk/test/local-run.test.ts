// A run on a plain local directory (localRun): one machine, no Archil, no mount token.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { localRun } from "../src/local-run.ts";
import { openDurableRun, RunError } from "../src/run.ts";
import { parseRunRecord, RUN_JSON } from "../src/status.ts";
import { reapOrRefuse } from "../src/commands.ts";
import { FencedError, HeldError } from "../src/errors.ts";
import { processTable } from "../src/process-table.ts";
import { alive, ctx, killQuietly, scratchRoot, scriptedHarness, startCommand } from "./_run-support.ts";

const ref = { disk: "dsk-local", region: "local", id: "run-1" };
const LOCAL_COMMAND = fileURLToPath(new URL("./fixtures/local-command.ts", import.meta.url));
const HELD_FORK = fileURLToPath(new URL("./fixtures/held-fork-command.ts", import.meta.url));
const BESIDE = fileURLToPath(new URL("./fixtures/beside-program.ts", import.meta.url));
const UNRECORDED = fileURLToPath(new URL("./fixtures/unrecorded-command.ts", import.meta.url));

/** Root's processes but pid 1 and kernel threads, from /proc on Linux and ps elsewhere (macOS). */
function rootPids(): number[] {
  if (process.platform !== "linux") {
    const rows = execFileSync("/bin/ps", ["-A", "-o", "pid=,uid="], { encoding: "utf8" }).split("\n").map((line) => line.trim().split(/\s+/).map(Number));
    return rows.filter(([pid, uid]) => pid! > 2 && uid === 0).map(([pid]) => pid!);
  }
  return readdirSync("/proc").filter((n) => /^\d+$/.test(n)).map(Number).filter((pid) => {
    try {
      return pid > 2 && /^Uid:\s+0\s/m.test(readFileSync(`/proc/${pid}/status`, "utf8")) && readFileSync(`/proc/${pid}/cmdline`, "utf8") !== "";
    } catch {
      return false; // gone, or not readable
    }
  });
}

/** A long-lived root-owned process this (unprivileged) user may not signal, with its start; undefined if none. */
function rootProcess(): { pid: number; start: number } | undefined {
  const look = processTable().snapshot();
  for (const pid of rootPids()) {
    const info = look.info(pid);
    if (info !== undefined) return { pid, start: info.start };
  }
  return undefined;
}

describe("localRun", () => {
  it("refuses to open beside a process a killed incarnation's commands left that outlives its SIGKILL, and opens once it is gone", { timeout: 60_000 }, async (t) => {
    // A process this user may not signal stands in for one that will not die (an uninterruptible wait). As root every
    // process can be signalled, so the test is skipped there rather than signal one.
    if (process.getuid?.() === 0) return t.skip("runs only as an unprivileged user");
    const survivor = rootProcess();
    if (survivor === undefined) return t.skip("no root-owned process to stand in for a survivor");
    const dir = scratchRoot("local-survivor");
    const root = join(dir.root, "run");
    const scripted = scriptedHarness();
    const open = () => openDurableRun({ disk: "dsk-local", region: "local", id: "survivor" }, { ...localRun(root), harness: { models: scripted.models, registry: scripted.registry } });
    try {
      await (await open()).release();
      const boot = processTable().bootId()!;
      const record = join(root, "commands", `${survivor.pid}-${survivor.start}.json`);
      mkdirSync(join(root, "commands"), { recursive: true });
      writeFileSync(record, JSON.stringify({ boot, leader: survivor, members: [] }));
      await assert.rejects(open(), (error: unknown) =>
        error instanceof HeldError && error.code === "COMMANDS_ALIVE" && error.exitCode === 76 && error.message.includes(`pid ${survivor.pid} (`) && /open the run again/.test(error.message));
      assert.ok(existsSync(record), "its record stays");
      // Gone, as the record can tell: the same pid with other start ticks is another process.
      writeFileSync(record, JSON.stringify({ boot, leader: { pid: survivor.pid, start: survivor.start + 1 }, members: [] }));
      const run = await open();
      assert.equal(existsSync(join(root, "commands")), false, "the records are cleared");
      await run.release();
    } finally {
      dir.remove();
    }
  });

  it("two local runs in one process: reopening one never kills a command of the other", { timeout: 60_000 }, async () => {
    const dir = scratchRoot("local-two");
    const open = (id: string) => {
      const scripted = scriptedHarness();
      return openDurableRun({ disk: "dsk-local", region: "local", id }, { ...localRun(join(dir.root, id)), harness: { models: scripted.models, registry: scripted.registry } }).then((run) => ({ run, agent: scripted.agent }));
    };
    let [commandA, commandB] = [0, 0];
    try {
      const a = await open("a");
      commandA = await startCommand(a.run, a.agent);
      const b = await open("b");
      commandB = await startCommand(b.run, b.agent);
      await new Promise((resolve) => setTimeout(resolve, 400)); // several walks of both recorders while both commands run
      await b.run.release(); // ends b's command; a's goes on
      assert.deepEqual([alive(commandA), alive(commandB)], [true, false]);
      const b2 = await open("b"); // its commands step reaps what b recorded
      assert.ok(alive(commandA), "a's command outlived the reopening of b");
      await b2.run.release();
      await a.run.release();
    } finally {
      for (const pid of [commandA, commandB]) if (pid > 0) killQuietly(pid);
      dir.remove();
    }
  });

  it("ends the commands a SIGKILLed instance left running at the next open, before afterClaim and run.json", { timeout: 60_000 }, async () => {
    const dir = scratchRoot("local-commands");
    const root = join(dir.root, "run");
    const instance = spawn(process.execPath, [LOCAL_COMMAND, root], { stdio: ["ignore", "pipe", "inherit"] });
    let command = 0;
    try {
      const line = (await createInterface({ input: instance.stdout! })[Symbol.asyncIterator]().next()).value as string | undefined;
      command = Number(/^ready (\d+)$/.exec(line ?? "")?.[1] ?? 0);
      assert.ok(command > 0 && alive(command), `the agent's command runs: ${line}`);
      instance.kill("SIGKILL");
      await new Promise((resolve) => instance.once("close", resolve));
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.ok(alive(command), "the instance's SIGKILL does not reach its command's child, in the command's own process group");
      const scripted = scriptedHarness();
      const steps: [string, boolean][] = [];
      let factorySaw: boolean | undefined;
      const run = await openDurableRun({ disk: "dsk-local", region: "local", id: "local-command" }, {
        ...localRun(root),
        afterClaim: async () => {
          factorySaw = alive(command);
          return { harness: { models: scripted.models, registry: scripted.registry } };
        },
        onStep: (name) => void steps.push([name, alive(command)]),
      });
      assert.deepEqual(steps.map(([step]) => step).slice(0, 5), ["acquire", "owner-lock", "layout", "commands", "after-claim"], "the reap, then the app's code, then run.json");
      assert.deepEqual(steps[3], ["commands", false], "the command is gone once the commands step ends");
      assert.equal(factorySaw, false, "afterClaim never runs beside the killed incarnation's command");
      assert.equal(run.generation, 2);
      await run.release();
    } finally {
      instance.kill("SIGKILL");
      if (command > 0) killQuietly(command);
      dir.remove();
    }
  });

  it("ends a command's child forked after the recorder's last walk: the command, its group's leader, outlives a SIGKILLed instance, so the next open kills its whole group", { timeout: 60_000 }, async () => {
    const dir = scratchRoot("held-fork");
    const root = join(dir.root, "run");
    const fifo = join(dir.root, "hold.fifo");
    execFileSync("mkfifo", [fifo]);
    const instance = spawn(process.execPath, [HELD_FORK, root, fifo], { stdio: ["ignore", "pipe", "inherit"] });
    const closed = new Promise((resolve) => instance.once("close", resolve));
    let leader = 0;
    let child = 0;
    try {
      const line = (await createInterface({ input: instance.stdout! })[Symbol.asyncIterator]().next()).value as string | undefined;
      leader = Number(/^ready (\d+)$/.exec(line ?? "")?.[1] ?? 0);
      assert.ok(leader > 0 && alive(leader), `the agent's command runs: ${line}`);
      const commands = join(root, "commands");
      const record = () => {
        const name = readdirSync(commands).find((entry) => entry.startsWith(`${leader}-`));
        return name === undefined ? undefined : (JSON.parse(readFileSync(join(commands, name), "utf8")) as { leader: { pid: number } | null; members: { pid: number }[] });
      };
      assert.equal(record()?.leader?.pid, leader, "the command is recorded as its group's leader");
      // No walk runs from here: the instance is stopped. The command forks its child only now, after the last walk.
      instance.kill("SIGSTOP");
      writeFileSync(fifo, "go\n");
      const childFile = join(root, "work", "held.child");
      for (let i = 0; i < 500 && !(existsSync(childFile) && readFileSync(childFile, "utf8").trim() !== ""); i++) await new Promise((resolve) => setTimeout(resolve, 10));
      child = Number(readFileSync(childFile, "utf8").trim());
      assert.ok(child > 0 && alive(child), "the command forked its child");
      assert.equal(processTable().snapshot().info(child)?.pgrp, leader, "the child is in the command's group");
      assert.deepEqual(record()?.members, [], "no walk recorded the child");
      instance.kill("SIGKILL");
      await closed;
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.ok(alive(leader), "the command, its group's leader, outlives the instance: a recorded command has no death signal");
      assert.ok(alive(child), "and so does its child");
      // The open's commands step (run.ts), on the record the killed instance left.
      const reaped = await reapOrRefuse(commands);
      assert.ok(reaped.signalled >= 1, `the reap signalled the group: ${JSON.stringify(reaped)}`);
      assert.deepEqual(reaped.survivors, []);
      assert.equal(alive(child), false, "the child no walk recorded is gone");
      assert.equal(alive(leader), false, "the command is gone");
      assert.equal(existsSync(commands), false, "the record is cleared");
      const scripted = scriptedHarness();
      const run = await openDurableRun({ disk: "dsk-local", region: "local", id: "held-fork" }, { ...localRun(root), harness: { models: scripted.models, registry: scripted.registry } });
      assert.equal(run.generation, 2);
      await run.release();
    } finally {
      instance.kill("SIGKILL");
      killQuietly(child);
      killQuietly(leader);
      dir.remove();
    }
  });

  it("ends a command whose instance was killed before any walk recorded it: the recorder's mark, written before the command started, names it", { timeout: 60_000 }, async () => {
    const dir = scratchRoot("unrecorded");
    const commands = join(dir.root, "commands");
    const pidFile = join(dir.root, "command.pid");
    let command = 0;
    try {
      const instance = spawn(process.execPath, [UNRECORDED, commands, pidFile], { stdio: "ignore" });
      const signal = await new Promise((resolve) => instance.once("close", (_code, signal) => resolve(signal)));
      assert.equal(signal, "SIGKILL", "the instance killed itself in the turn that started the command");
      command = Number(readFileSync(pidFile, "utf8"));
      assert.ok(command > 0 && alive(command), "the command outlives its instance");
      assert.deepEqual((existsSync(commands) ? readdirSync(commands) : []).filter((name) => /^\d+-\d+\.json$/.test(name)), [], "no walk ran, so nothing recorded the command");
      // The open's commands step (run.ts), on what the killed instance left.
      const reaped = await reapOrRefuse(commands);
      assert.ok(reaped.signalled >= 1, `the reap signalled the command: ${JSON.stringify(reaped)}`);
      assert.deepEqual(reaped.survivors, []);
      assert.equal(alive(command), false, "the command is gone");
      assert.equal(existsSync(commands), false, "the mark is cleared");
    } finally {
      killQuietly(command);
      dir.remove();
    }
  });

  it("a program started beside pi under the run's confinePrefix (another harness's CLI) still dies with the instance that started it", { timeout: 60_000 }, async (t) => {
    const dir = scratchRoot("beside");
    const instance = spawn(process.execPath, [BESIDE, join(dir.root, "run")], { stdio: ["ignore", "pipe", "inherit"] });
    const closed = new Promise((resolve) => instance.once("close", resolve));
    let program = 0;
    try {
      const line = (await createInterface({ input: instance.stdout! })[Symbol.asyncIterator]().next()).value as string | undefined;
      program = Number(/^ready (\d+)$/.exec(line ?? "")?.[1] ?? -1);
      if (program === 0) return t.skip("the run confines nothing here (no setpriv), so there is no death signal to keep");
      assert.ok(program > 0 && alive(program), `the program runs: ${line}`);
      instance.kill("SIGKILL");
      await closed;
      for (let i = 0; i < 500 && alive(program); i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(alive(program), false, "the program died with the instance (--pdeathsig KILL)");
    } finally {
      instance.kill("SIGKILL");
      killQuietly(program);
      dir.remove();
    }
  });

  it("opens a run on a local directory with no mount token, keeps its turns, and opens it again as the next generation", async () => {
    const dir = scratchRoot("local");
    const root = join(dir.root, "runs", "run-1"); // not there yet: the claim makes it
    try {
      const scripted = scriptedHarness();
      const run1 = await openDurableRun(ref, { ...localRun(root), harness: { models: scripted.models, registry: scripted.registry } });
      assert.equal(run1.claim.root, root);
      assert.equal(run1.claim.work, join(root, "work"));
      assert.ok(existsSync(join(root, RUN_JSON)), "run.json is written in the directory");
      const conversation = await run1.harness.root(ctx, { agent: scripted.agent });
      await conversation.configure({ instructions: "local" }, ctx);
      await run1.release();
      const sealed = parseRunRecord(readFileSync(join(root, RUN_JSON), "utf8"));
      assert.equal(sealed.generation, 1);
      assert.ok(typeof sealed.sealedSeq === "number" && sealed.sealedSeq > 0, "released and sealed");

      const run2 = await openDurableRun(ref, { ...localRun(root), harness: { models: scripted.models, registry: scripted.registry } });
      assert.equal(run2.generation, 2);
      await run2.release();
    } finally {
      dir.remove();
    }
  });

  it("says it is one machine's: a second open of the same directory while the first holds it is refused by the owner lock", async () => {
    const dir = scratchRoot("local-held");
    try {
      const scripted = scriptedHarness();
      const options = { ...localRun(dir.root), harness: { models: scripted.models, registry: scripted.registry } };
      const run = await openDurableRun(ref, options);
      try {
        await assert.rejects(openDurableRun(ref, options));
      } finally {
        await run.release();
      }
    } finally {
      dir.remove();
    }
  });

  it("its claim's barrier refuses once the claim is fenced, as a mount's does", async () => {
    const dir = scratchRoot("local-fence");
    try {
      const claim = await localRun(dir.root).acquire({ ref, token: "" });
      assert.deepEqual(await claim.barrier(), { ms: 0 });
      claim.markFenced(new Error("lost"));
      assert.equal(claim.fenced, true);
      await assert.rejects(claim.barrier(), (error: unknown) => error instanceof FencedError);
      assert.deepEqual(await claim.release(), { via: "none" });
    } finally {
      dir.remove();
    }
  });
});

describe("the mount token", () => {
  it("is required only to mount an Archil disk: with the default acquire and none, the open is refused before anything mounts", async () => {
    const scripted = scriptedHarness();
    await assert.rejects(
      openDurableRun(ref, { harness: { models: scripted.models, registry: scripted.registry } }),
      (error: unknown) => error instanceof RunError && error.code === "INVALID_ARGUMENT" && /mountToken/.test(error.message) && /localRun/.test(error.message),
    );
  });
});

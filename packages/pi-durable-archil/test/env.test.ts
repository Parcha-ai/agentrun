import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import type { JsonObject, ToolRegistration } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import type { ShellExecOptions } from "@earendil-works/pi-durable/env";
import type { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import {
  archilEnv,
  EnvClosedError,
  EnvError,
  ArchilCodingTools,
  markReadOnlySafe,
  READ_ONLY_TOOLS,
  replaySafe,
  workspaceBarrier,
  WRITING_TOOLS,
} from "../src/env.ts";
import { registerEnvCases } from "./_env-conformance.ts";

const context = BACKGROUND_CONTEXT;

async function withRun<T>(use: (run: { root: string; work: string }) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "pda-env-"));
  const work = join(root, "work");
  await mkdir(work);
  try {
    return await use({ root, work });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("archilEnv on local disk passes pi's env conformance", () => {
  registerEnvCases("archilEnv", (use) => withRun(({ root, work }) => use(archilEnv({ root, work, disk: "dsk-local" })({}))));
});

describe("the environment", () => {
  const claim = { root: "/mnt/archil/runs/r1", work: "/mnt/archil/runs/r1/work", disk: "dsk-1" };

  it("has an id that names the run and is the same for every construction of the same claim", () => {
    const first = archilEnv(claim);
    const second = archilEnv({ ...claim });
    assert.equal(first.id, "archil:dsk-1:/mnt/archil/runs/r1");
    assert.equal(second.id, first.id);
    assert.equal(first({}).id, first.id);
    assert.equal(first({ cwd: "sub" }).id, first.id);
    assert.equal(second({}).id, first.id);
    assert.notEqual(first.id, "node:local");
  });

  it("has different ids for different runs and disks", () => {
    const other = { root: "/mnt/archil/runs/r2", work: "/mnt/archil/runs/r2/work", disk: "dsk-1" };
    assert.notEqual(archilEnv(other).id, archilEnv(claim).id);
    assert.notEqual(archilEnv({ ...claim, disk: "dsk-2" }).id, archilEnv(claim).id);
    assert.equal(archilEnv({ root: claim.root, work: claim.work }).id, "archil:/mnt/archil/runs/r1");
  });

  it("is rooted at work/ and resolves an agent cwd against it", () => {
    const env = archilEnv(claim);
    assert.equal(env({}).cwd, claim.work);
    assert.equal(env({ cwd: "repo/src" }).cwd, `${claim.work}/repo/src`);
    assert.equal(env({ cwd: `${claim.work}/abs` }).cwd, `${claim.work}/abs`);
  });

  it("watches by polling unless told otherwise", async () => {
    await withRun(async ({ root, work }) => {
      const env = archilEnv({ root, work })({});
      const watcher = getOrThrow(await env.watch([{ path: "f.txt" }], () => {}, context));
      assert.equal(watcher.mode, "polling");
      await watcher.close(context);
      const native = archilEnv({ root, work }, { watch: { mode: "native" } })({});
      const nativeWatcher = getOrThrow(await native.watch([{ path: "f.txt" }], () => {}, context));
      assert.equal(nativeWatcher.mode, "native");
      await nativeWatcher.close(context);
    });
  });

  it("kills the commands of every environment it built on cleanup", async () => {
    await withRun(async ({ root, work }) => {
      const factory = archilEnv({ root, work });
      let pidText = "";
      const started = new Promise<void>((resolve) => {
        void factory({}).exec(
          "echo $$; exec sleep 60",
          {
            onOutput: (text) => {
              pidText += text;
              if (pidText.includes("\n")) resolve();
            },
          },
          context,
        ).then((result) => {
          finished = result;
        });
      });
      let finished: Awaited<ReturnType<ReturnType<typeof factory>["exec"]>> | undefined;
      await started;
      const pid = Number(pidText.trim());
      assert.ok(Number.isInteger(pid) && pid > 1, `pid ${pidText}`);
      process.kill(pid, 0);
      await factory.cleanup(context);
      const deadline = Date.now() + 5000;
      while (finished === undefined && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(finished !== undefined && !finished.ok && finished.error.code === "aborted", "the running command ends aborted");
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      // Nothing is left to kill once the command is gone.
      await factory.cleanup(context);
    });
  });

  describe("after cleanup()", () => {
    const touch = (work: string) => ["sh", "-c", `touch ${work}/spawned`];

    it("refuses every command, from environments built before and after, and starts nothing", async () => {
      await withRun(async ({ root, work }) => {
        const factory = archilEnv({ root, work });
        const before = factory({});
        const beforeWithCwd = factory({ cwd: "sub" });
        assert.ok((await before.exec(["true"], undefined, context)).ok, "open before cleanup");
        await factory.cleanup(context);
        const after = factory({});
        for (const env of [before, beforeWithCwd, after]) {
          for (const command of [touch(work), `touch ${work}/spawned`, ["true"], []]) {
            const result = await env.exec(command, undefined, context);
            assert.ok(!result.ok, JSON.stringify(command));
            assert.ok(result.error instanceof EnvClosedError, String(result.error));
            assert.equal(result.error.reason, "env_closed");
            assert.equal(result.error.code, "spawn_error");
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(existsSync(join(work, "spawned")), false, "no command ran");
      });
    });

    it("refuses a command whose cleanup came while it was being prepared", async () => {
      await withRun(async ({ root, work }) => {
        const factory = archilEnv({ root, work });
        const racing = factory({}).exec(touch(work), undefined, context);
        const cleaned = factory.cleanup(context);
        const result = await racing;
        await cleaned;
        assert.ok(!result.ok && result.error instanceof EnvClosedError);
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(existsSync(join(work, "spawned")), false, "no command ran");
      });
    });

    it("refuses without confinement too, and leaves other factories and the file operations alone", async () => {
      await withRun(async ({ root, work }) => {
        const closed = archilEnv({ root, work }, { noNewPrivs: false });
        const other = archilEnv({ root, work });
        await closed.cleanup(context);
        const refused = await closed({}).exec(["true"], undefined, context);
        assert.ok(!refused.ok && refused.error instanceof EnvClosedError);
        assert.ok((await other({}).exec(["true"], undefined, context)).ok, "another factory still runs commands");
        getOrThrow(await closed({}).writeFile("f.txt", "still writable", context));
        assert.equal(getOrThrow(await closed({}).readTextFile("f.txt", context)), "still writable");
      });
    });
  });
});

describe("the tools", () => {
  const byName = new Map((ArchilCodingTools.tools ?? []).map((tool) => [tool.name, tool]));

  it("keep pi's extension name, so installing them replaces CodingTools in place", () => {
    assert.equal(ArchilCodingTools.name, CodingTools.name);
    assert.deepEqual([...byName.keys()], (CodingTools.tools ?? []).map((tool) => tool.name));
  });

  it("report read as safe and the writing tools as not safe", () => {
    assert.equal(byName.get("read")?.replay, "safe");
    for (const name of ["write", "edit", "bash"]) {
      assert.ok(byName.has(name), name);
      assert.notEqual(byName.get(name)?.replay, "safe", name);
    }
  });

  it("classify every tool pi ships as read-only or writing, so a new built-in forces a decision", () => {
    for (const tool of CodingTools.tools ?? []) {
      assert.ok(READ_ONLY_TOOLS.has(tool.name) !== WRITING_TOOLS.has(tool.name), `${tool.name} is unclassified`);
    }
    for (const name of READ_ONLY_TOOLS) assert.ok(!WRITING_TOOLS.has(name), name);
  });

  it("declare an app's ls, find and grep safe through markReadOnlySafe, leaving the rest and the input untouched", () => {
    const tool = (name: string) => ({ name, description: name, parameters: {}, execute: async () => ({}) }) as unknown as ToolRegistration;
    const input = ["ls", "find", "grep", "read", "write", "delete", "deploy"].map(tool);
    const marked = markReadOnlySafe(input);
    assert.deepEqual(
      marked.map((each) => [each.name, each.replay]),
      [["ls", "safe"], ["find", "safe"], ["grep", "safe"], ["read", "safe"], ["write", undefined], ["delete", undefined], ["deploy", undefined]],
    );
    assert.ok(input.every((each) => each.replay === undefined), "input is not mutated");
    assert.equal(marked[0]?.execute, input[0]?.execute);
    assert.equal(replaySafe(tool("search")).replay, "safe");
    assert.equal(markReadOnlySafe([tool("search")], new Set(["search"]))[0]?.replay, "safe");
  });
});

type Run = { barrierCalls: string[]; toolResultsAtBarrier: number[]; filesAtBarrier: boolean[]; texts: string[] };

async function drive(
  barrier: ((callName: string) => Promise<void>) | undefined,
  calls: Array<[string, JsonObject]>,
  inspect?: (run: { root: string; work: string; texts: string[] }) => Promise<void>,
) {
  return await withRun(async ({ root, work }) => {
    const run: Run = { barrierCalls: [], toolResultsAtBarrier: [], filesAtBarrier: [], texts: [] };
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      ...calls.map(([name, args], index) => fauxAssistantMessage(fauxToolCall(name, args, { id: `call-${index}` }), { stopReason: "toolUse" })),
      fauxAssistantMessage("done"),
    ]);
    const registry = createRegistry();
    registry.install(ArchilCodingTools);
    const harness = await Harness.open(new MemoryStorage(), { models, registry, env: archilEnv({ root, work }) }, context);
    try {
      const model = faux.getModel();
      const conversation = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
      if (barrier !== undefined) {
        registry.install(
          workspaceBarrier(async (call) => {
            run.barrierCalls.push(call.name);
            const page = await conversation.entries({}, 100, undefined, context);
            run.toolResultsAtBarrier.push(page.items.filter((entry) => entry.kind === "pi.tool-result").length);
            run.filesAtBarrier.push(existsSync(join(work, "a.txt")));
            await barrier(call.name);
          }),
        );
      }
      const submission = await conversation.submit({ type: "input", content: "go" }, context);
      const settled = await submission.wait(context);
      assert.equal(settled.status, "done");
      const page = await conversation.entries({}, 100, undefined, context);
      run.texts = page.items.filter((entry) => entry.kind === "pi.tool-result").map((entry) => JSON.stringify(entry));
      await inspect?.({ root, work, texts: run.texts });
      return { run, work, written: existsSync(join(work, "a.txt")) ? await readFile(join(work, "a.txt"), "utf8") : undefined };
    } finally {
      await harness.close(context);
    }
  });
}

describe("the workspace barrier through a pi Harness", () => {
  it("runs after a writing tool and before its result entry commits, and not for read", async () => {
    const { run, written } = await drive(async () => {}, [
      ["write", { path: "a.txt", content: "hello" }],
      ["read", { path: "a.txt" }],
      ["bash", { command: "true" }],
    ]);
    assert.equal(written, "hello");
    assert.deepEqual(run.barrierCalls, ["write", "bash"]);
    assert.deepEqual(run.toolResultsAtBarrier, [0, 2], "the write's barrier saw no result entry; bash's saw the earlier two");
    assert.deepEqual(run.filesAtBarrier, [true, true], "the file was on disk when the barrier ran");
  });

  it("is absent from a registry that does not install it", async () => {
    const { run, written } = await drive(undefined, [["write", { path: "a.txt", content: "x" }]]);
    assert.equal(written, "x");
    assert.deepEqual(run.barrierCalls, []);
  });

  it("turns a failed barrier into an error result with workspace_not_durable instead of a success", async () => {
    const { run } = await drive(
      async () => {
        throw new Error("archil sync failed");
      },
      [["write", { path: "a.txt", content: "x" }]],
    );
    assert.deepEqual(run.barrierCalls, ["write"]);
    assert.equal(run.texts.length, 1);
    assert.match(run.texts[0]!, /workspace_not_durable/);
    assert.match(run.texts[0]!, /archil sync failed/);
    assert.match(run.texts[0]!, /"isError":true/);
  });

  it("covers an app's own writing tools named in options", async () => {
    const seen: string[] = [];
    const extension = workspaceBarrier(async (call) => void seen.push(call.name), { tools: ["deploy"] });
    const registration = extension.hooks?.[0];
    assert.equal(registration?.task, "pi.tool");
    const { afterTool } = registration!.handlers as { afterTool(call: { name: string }, result: object, api: undefined, context: Context): Promise<unknown> };
    await afterTool({ name: "deploy" }, {}, undefined, context);
    await afterTool({ name: "write" }, {}, undefined, context);
    assert.deepEqual(seen, ["deploy"]);
  });
});

describe("temporary files live under <root>/tmp", () => {
  it("creates temp directories and files there, outside work/, keeping the prefix and a 0755 tmp", async () => {
    await withRun(async ({ root, work }) => {
      const env = archilEnv({ root, work })({});
      const tmp = join(root, "tmp");
      assert.equal(existsSync(tmp), false, "nothing is created before the first use");
      const dir = getOrThrow(await env.createTempDir("scratch-", context));
      assert.equal(dirname(dir), tmp);
      assert.ok(basename(dir).startsWith("scratch-"), dir);
      assert.equal((await stat(tmp)).mode & 0o777, 0o755);
      assert.ok(!dir.startsWith(`${work}/`) && dir !== work);
      const bare = getOrThrow(await env.createTempDir(undefined, context));
      assert.ok(basename(bare).startsWith("tmp-"), bare);
      const file = getOrThrow(await env.createTempFile({ prefix: "p-", suffix: ".log" }, context));
      assert.equal(dirname(dirname(file)), tmp);
      assert.match(basename(file), /^p-.*\.log$/);
      assert.equal(await readFile(file, "utf8"), "");
      // A second environment of the same run shares the directory and leaves its mode alone.
      const other = getOrThrow(await archilEnv({ root, work })({ cwd: "sub" }).createTempDir("o-", context));
      assert.equal(dirname(other), tmp);
      assert.equal((await stat(tmp)).mode & 0o777, 0o755);
    });
  });

  it("refuses an aborted call and reports a failure as a pi FileError", async () => {
    await withRun(async ({ root, work }) => {
      const controller = new AbortController();
      controller.abort();
      const aborted = await archilEnv({ root, work })({}).createTempDir("x-", withAbortSignal(controller.signal, context));
      assert.ok(!aborted.ok && aborted.error.code === "aborted");
      await writeFile(join(root, "not-a-directory"), "");
      const notDirectory = await archilEnv({ root: join(root, "not-a-directory"), work })({}).createTempDir("x-", context);
      assert.ok(!notDirectory.ok && notDirectory.error.code === "not_directory", JSON.stringify(notDirectory));
    });
  });

  it("writes the spill of a command's output under <root>/tmp", async () => {
    await withRun(async ({ root, work }) => {
      const env = archilEnv({ root, work })({});
      let seen = "";
      const result = getOrThrow(
        await env.exec("seq 1 3000", { spill: { afterBytes: 1024, afterLines: 100 }, onOutput: (text) => void (seen += text) }, context),
      );
      assert.ok(result.spillPath !== undefined, "the output spilled");
      assert.equal(dirname(dirname(result.spillPath)), join(root, "tmp"));
      assert.match(basename(result.spillPath), /^pi-output-.*\.log$/);
      assert.equal(await readFile(result.spillPath, "utf8"), seen);
      assert.equal(seen.trimEnd().split("\n").length, 3000);
    });
  });

  it("names the spill of a bash tool call under <root>/tmp, and the file holds the full output", async () => {
    await drive(undefined, [["bash", { command: "seq 1 100000" }]], async ({ root, texts }) => {
      assert.equal(texts.length, 1);
      const named = /Full output: ([^"\\]+\.log)/.exec(texts[0]!);
      assert.ok(named, texts[0]);
      const spill = named[1]!;
      assert.equal(dirname(dirname(spill)), join(root, "tmp"));
      const full = (await readFile(spill, "utf8")).trimEnd().split("\n");
      assert.equal(full.length, 100000);
      assert.equal(full.at(-1), "100000");
    });
  });
});

describe("commands run under no_new_privs", () => {
  const flagOf = (text: string) => /^NoNewPrivs:\s+(\d)/m.exec(text)?.[1];
  // A test runner that is itself under no_new_privs (a unit with NoNewPrivileges=yes) shows 1 without the option.
  const ownFlag = flagOf(readFileSync("/proc/self/status", "utf8"));
  const sudoWorksHere = spawnSync("sudo", ["-n", "true"], { stdio: "ignore" }).status === 0;

  async function run(env: NodeExecutionEnv, command: string | readonly string[], options?: ShellExecOptions) {
    let out = "";
    const result = await env.exec(command, { ...options, onOutput: (text) => void (out += text) }, context);
    return { result, out };
  }
  const outcome = async (env: NodeExecutionEnv, command: string | readonly string[], options?: ShellExecOptions) => {
    const { result, out } = await run(env, command, options);
    return result.ok ? { ok: true, exitCode: result.value.exitCode, out } : { ok: false, code: result.error.code };
  };
  const STATUS = "grep NoNewPrivs /proc/self/status";

  it("set the flag for string and argv commands and for what they start", async () => {
    await withRun(async ({ root, work }) => {
      const env = archilEnv({ root, work })({});
      assert.equal(flagOf((await run(env, STATUS)).out), "1");
      assert.equal(flagOf((await run(env, ["grep", "NoNewPrivs", "/proc/self/status"])).out), "1");
      assert.equal(flagOf((await run(env, `sh -c 'sh -c "${STATUS}"'`)).out), "1");
      const shell = await run(env, "echo $$");
      assert.ok(shell.result.ok && shell.result.value.exitCode === 0);
    });
  });

  it("are left as they were with noNewPrivs: false, and the factory then needs no setpriv", async () => {
    await withRun(async ({ root, work }) => {
      const env = archilEnv({ root, work }, { noNewPrivs: false, setprivPath: "/nonexistent/setpriv" })({});
      assert.equal(flagOf((await run(env, STATUS)).out), ownFlag);
      assert.equal(flagOf((await run(env, ["grep", "NoNewPrivs", "/proc/self/status"])).out), ownFlag);
    });
  });

  it("refuse a program that checks the flag, as sudo does", async () => {
    await withRun(async ({ root, work }) => {
      const bin = join(root, "bin");
      await mkdir(bin);
      await writeFile(join(bin, "sudo"), "#!/bin/sh\ngrep -q '^NoNewPrivs:.1' /proc/self/status && { echo refused; exit 77; }\necho granted\n", { mode: 0o755 });
      const env = { PATH: `${bin}:${process.env.PATH}` };
      const confined = archilEnv({ root, work })({});
      assert.deepEqual(await outcome(confined, ["sudo", "-n", "true"], { env }), { ok: true, exitCode: 77, out: "refused\n" });
      assert.deepEqual(await outcome(confined, "sudo -n true", { env }), { ok: true, exitCode: 77, out: "refused\n" });
      const open = archilEnv({ root, work }, { noNewPrivs: false })({});
      if (ownFlag === "0") assert.deepEqual(await outcome(open, ["sudo", "-n", "true"], { env }), { ok: true, exitCode: 0, out: "granted\n" });
    });
  });

  it("cannot use the real sudo -n true, which works for the run user outside them", { skip: !sudoWorksHere && "no passwordless sudo here" }, async () => {
    await withRun(async ({ root, work }) => {
      const env = archilEnv({ root, work })({});
      const refused = await run(env, ["sudo", "-n", "true"]);
      assert.ok(refused.result.ok && refused.result.value.exitCode !== 0, JSON.stringify(refused));
      assert.match(refused.out, /no new privileges/i);
      if (ownFlag === "0") assert.equal((await run(archilEnv({ root, work }, { noNewPrivs: false })({}), ["sudo", "-n", "true"])).out, "");
    });
  });

  it("fail before spawning exactly where pi's own exec does", async () => {
    await withRun(async ({ root, work }) => {
      await mkdir(join(work, "sub"));
      await writeFile(join(work, "plain.sh"), "#!/bin/sh\necho plain\n", { mode: 0o644 });
      await writeFile(join(work, "run.sh"), "#!/bin/sh\necho ran\n", { mode: 0o755 });
      await writeFile(join(work, "sub", "tool.sh"), "#!/bin/sh\necho tool\n", { mode: 0o755 });
      const confined = archilEnv({ root, work })({});
      const open = archilEnv({ root, work }, { noNewPrivs: false })({});
      const cases: Array<[string, string | readonly string[], ShellExecOptions?]> = [
        ["missing program", ["pi-durable-missing-program"]],
        ["missing path", ["./missing.sh"]],
        ["not executable", ["./plain.sh"]],
        ["a directory", ["sub"]],
        ["an empty program", [""]],
        ["empty argv", []],
        ["relative path", ["./run.sh"]],
        ["relative path under cwd", ["./tool.sh"], { cwd: "sub" }],
        ["PATH from options.env", ["tool.sh"], { env: { PATH: `${join(work, "sub")}:${process.env.PATH}` } }],
        ["program only on the inherited PATH", ["tool.sh"]],
        ["a cwd that does not exist", ["sh", "-c", "true"], { cwd: "nowhere" }],
        ["no inherited env", ["/bin/sh", "-c", "echo $0; exit 3"], { inheritEnv: false, env: { PATH: "/usr/bin:/bin" } }],
        ["a string", "exit 4"],
        ["a string with quotes, newlines, a dollar and unicode", "printf '%s|' \"it's\" '\"q\"' '$HOME' 'ü\\n'; echo\nprintf 'two\\n'"],
      ];
      for (const [label, command, options] of cases) {
        assert.deepEqual(await outcome(confined, command, options), await outcome(open, command, options), label);
      }
      assert.deepEqual(await outcome(confined, ["pi-durable-missing-program"]), { ok: false, code: "spawn_error" });
      assert.deepEqual(await outcome(confined, ["./run.sh"]), { ok: true, exitCode: 0, out: "ran\n" });
    });
  });

  it("run a custom shell as pi does, and report a missing one as shell_unavailable", async () => {
    await withRun(async ({ root, work }) => {
      for (const noNewPrivs of [true, false]) {
        const custom = archilEnv({ root, work }, { noNewPrivs, shellPath: "/bin/sh" })({});
        assert.deepEqual(await outcome(custom, "echo $0"), { ok: true, exitCode: 0, out: "/bin/sh\n" });
        const missing = archilEnv({ root, work }, { noNewPrivs, shellPath: "/nonexistent/shell" })({});
        assert.deepEqual(await outcome(missing, "true"), { ok: false, code: "shell_unavailable" });
      }
    });
  });

  it("refuse to build the factory when setpriv is unusable, naming the way out", async () => {
    await withRun(async ({ root, work }) => {
      const notExecutable = join(root, "setpriv");
      await writeFile(notExecutable, "#!/bin/sh\n", { mode: 0o644 });
      for (const setprivPath of ["/nonexistent/setpriv", notExecutable, root]) {
        assert.throws(
          () => archilEnv({ root, work }, { setprivPath }),
          (error: unknown) =>
            error instanceof EnvError &&
            error.code === "SETPRIV_UNAVAILABLE" &&
            error.exitCode === 1 &&
            error.message.includes(setprivPath) &&
            error.message.includes("noNewPrivs: false"),
          setprivPath,
        );
        assert.doesNotThrow(() => archilEnv({ root, work }, { setprivPath, noNewPrivs: false }));
      }
      assert.doesNotThrow(() => archilEnv({ root, work }));
    });
  });

  it("are what the bash tool runs under, through a real Harness", async () => {
    await drive(undefined, [["bash", { command: STATUS }]], async ({ texts }) => {
      assert.equal(texts.length, 1);
      assert.match(texts[0]!, /NoNewPrivs:\\t1/);
      assert.doesNotMatch(texts[0]!, /"isError":true/);
    });
  });
});

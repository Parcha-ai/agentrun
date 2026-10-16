// The in-process file operations are confined to the workspace (src/confine.ts): every path-taking method of the
// environment refuses a path that resolves outside work/, by `..`, an absolute path, a symlink (also one made by a command,
// a dangling one, a directory one), or a component swapped for a symlink after the check. confine-by-path.test.ts runs
// these again with every layout's environment confined by path, as on macOS (which has no /proc/self/fd), where they run
// so natively.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, open, readdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import type { JsonObject } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import type { FileError, Result } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { confineHooks, namesHeld, PathOutsideWorkError } from "../src/confine.ts";
import { ArchilCodingTools, archilEnv, EnvError } from "../src/env.ts";
import type { ArchilEnvOptions } from "../src/env.ts";
import { groupRuns, SWAPPER_CAP_SECONDS, spawnSwapper, stopSwapper, swapperLoop } from "./fixtures/swapper.ts";
import { asPlatform } from "./_macos.ts";
import { alive } from "./_run-support.ts";

const context = BACKGROUND_CONTEXT;
const SQLITE = "SQLITE-SENTINEL";
const RM = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;

/** Whether the layouts' environments walk paths by name: on macOS, or when confine-by-path.test.ts runs this file. */
const byPath = process.platform === "darwin" || (globalThis as { confineByPath?: boolean }).confineByPath === true;

interface Layout {
  readonly base: string;
  readonly work: string;
  readonly store: string;
  readonly sqlite: string;
  readonly elsewhere: string;
  readonly claim: { root: string; work: string };
  env(options?: ArchilEnvOptions, cwd?: string): NodeExecutionEnv;
}

/** A run directory the way the claim lays it out (run.json, owner.lock, store/, work/, tmp/), plus a directory outside the claim, and links an agent could make. */
async function withLayout<T>(use: (layout: Layout) => Promise<T>): Promise<T> {
  const base = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "pda-confine-"));
  const work = join(base, "work");
  const store = join(base, "store");
  const elsewhere = join(base, "..", `${base.split("/").pop()}-elsewhere`);
  const sqlite = join(store, "run.sqlite");
  try {
    for (const dir of [work, store, join(base, "tmp"), elsewhere, join(work, "real-dir"), join(work, "sub")]) await mkdir(dir, { recursive: true });
    await writeFile(sqlite, SQLITE);
    await writeFile(join(base, "run.json"), '{"status":"running"}');
    await writeFile(join(base, "owner.lock"), "");
    await writeFile(join(elsewhere, "secret.txt"), "SECRET");
    await writeFile(join(work, "real.txt"), "inside");
    await writeFile(join(work, "real-dir", "f.txt"), "inside-dir");
    const links: Array<[string, string]> = [
      ["link-file", "../store/run.sqlite"],
      ["link-abs", sqlite],
      ["link-dir", "../store"],
      ["link-root", "/"],
      ["dangling", "../store/new.db"],
      ["chain2", "../store/run.sqlite"],
      ["chain1", "chain2"],
      ["inner-file", "real.txt"],
      ["inner-dir", "real-dir"],
    ];
    for (const [name, target] of links) await symlink(target, join(work, name));
    const claim = { root: base, work };
    const env = (options: ArchilEnvOptions = {}, cwd?: string) => {
      const factory = byPath ? asPlatform("darwin", () => archilEnv(claim, { noNewPrivs: false, ...options })) : archilEnv(claim, { noNewPrivs: false, ...options });
      return factory({ ...(cwd === undefined ? {} : { cwd }) });
    };
    return await use({ base, work, store, sqlite, elsewhere, claim, env });
  } finally {
    // With a short backoff: a process a test started may still be ending (an entry it made after the walk is ENOTEMPTY).
    await rm(base, RM);
    await rm(elsewhere, RM);
  }
}

/** Every file below the claim outside work/ and tmp/, and below the outside directory: contents, and an entry per directory. */
async function outside(layout: Layout): Promise<Record<string, string>> {
  const seen: Record<string, string> = {};
  const visit = async (dir: string, skip: readonly string[]) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (skip.includes(path)) continue;
      if (entry.isSymbolicLink()) seen[path] = `-> ${await readlink(path)}`;
      else if (entry.isDirectory()) {
        seen[path] = "<dir>";
        await visit(path, skip);
      } else seen[path] = await readFile(path, "utf8");
    }
  };
  await visit(layout.base, [layout.work, join(layout.base, "tmp")]);
  await visit(layout.elsewhere, []);
  return seen;
}

function refused(result: Result<unknown, FileError>, path: string, reason: "outside_work" | "changed" = "outside_work"): void {
  assert.ok(!result.ok, `${path}: expected a refusal, got ${JSON.stringify(result)}`);
  assert.ok(result.error instanceof PathOutsideWorkError, `${path}: ${result.error.name}: ${result.error.message}`);
  assert.equal(result.error.reason, reason, result.error.message);
  assert.equal(result.error.code, "permission_denied");
  assert.ok(result.error.message.includes(path), `the message names the path: ${result.error.message}`);
}

async function closeIfOpened(result: Result<unknown, FileError>): Promise<void> {
  if (result.ok && typeof result.value === "object" && result.value !== null && "close" in result.value) {
    await (result.value as { close(context: unknown): Promise<void> }).close(context);
  }
}

type Op = (env: NodeExecutionEnv, path: string) => Promise<Result<unknown, FileError>>;

const CONTENT_OPS: Record<string, Op> = {
  readTextFile: (env, path) => env.readTextFile(path, context),
  readBinaryFile: (env, path) => env.readBinaryFile(path, context),
  openTextLineReader: (env, path) => env.openTextLineReader(path, context),
  readTextLines: (env, path) => env.readTextLines(path, undefined, context),
  openBinaryReader: (env, path) => env.openBinaryReader(path, undefined, context),
  canonicalPath: (env, path) => env.canonicalPath(path, context),
  writeFile: (env, path) => env.writeFile(path, "PWNED", context),
  appendFile: (env, path) => env.appendFile(path, "PWNED", context),
  truncateFile: (env, path) => env.truncateFile(path, 0, context),
  flushFile: (env, path) => env.flushFile(path, context),
};

const ENTRY_OPS: Record<string, Op> = {
  fileInfo: (env, path) => env.fileInfo(path, context),
  exists: (env, path) => env.exists(path, context),
  remove: (env, path) => env.remove(path, { recursive: true, force: true }, context),
  createDirFlat: (env, path) => env.createDir(path, { recursive: false }, context),
};

const DIR_OPS: Record<string, Op> = {
  listDir: (env, path) => env.listDir(path, context),
  openDirReader: (env, path) => env.openDirReader(path, context),
  createDir: (env, path) => env.createDir(path, undefined, context),
  remove: (env, path) => env.remove(path, { recursive: true, force: true }, context),
  watch: (env, path) => env.watch([{ path }], () => {}, context),
};

describe("every escape is refused by every operation, and nothing outside work/ changes", () => {
  it("content operations: `..`, absolute paths, file and directory symlinks, a symlink to /, chains, dangling links, file URLs", async () => {
    await withLayout(async (layout) => {
      const { sqlite } = layout;
      const paths = [
        "../store/run.sqlite",
        sqlite,
        "link-file",
        "link-abs",
        "chain1",
        "link-dir/run.sqlite",
        "link-dir/new.txt",
        `link-root${sqlite}`,
        "link-root/etc/hostname",
        "dangling",
        "sub/../../store/run.sqlite",
        `file://${sqlite}`,
        "../run.json",
        "../owner.lock",
        "../../etc/passwd",
        "/etc/passwd",
      ];
      const before = await outside(layout);
      const env = layout.env();
      for (const [name, op] of Object.entries(CONTENT_OPS)) {
        for (const path of paths) {
          const result = await op(env, path);
          await closeIfOpened(result);
          try {
            refused(result, path);
          } catch (error) {
            throw new Error(`${name}(${path}): ${(error as Error).message}`);
          }
        }
      }
      assert.deepEqual(await outside(layout), before);
      assert.equal(await readFile(sqlite, "utf8"), SQLITE);
    });
  });

  it("operations on an entry: its parent must be inside, a symlink inside is the link itself", async () => {
    await withLayout(async (layout) => {
      const { sqlite } = layout;
      const paths = [
        "../store/run.sqlite",
        sqlite,
        "link-dir/run.sqlite",
        "link-dir/new.txt",
        `link-root${sqlite}`,
        "sub/../../store/run.sqlite",
        `file://${sqlite}`,
        "../run.json",
        "../store",
        "/etc",
      ];
      const before = await outside(layout);
      const env = layout.env();
      for (const [name, op] of Object.entries(ENTRY_OPS)) {
        for (const path of paths) {
          try {
            refused(await op(env, path), path);
          } catch (error) {
            throw new Error(`${name}(${path}): ${(error as Error).message}`);
          }
        }
      }
      assert.deepEqual(await outside(layout), before);
    });
  });

  it("directory operations: list, page, create, remove and watch refuse a directory outside", async () => {
    await withLayout(async (layout) => {
      const paths = ["..", "/", "../store", layout.store, "link-dir", "link-root", "link-root/etc", "../../elsewhere-nope", `${layout.store}/newdir`, "link-dir/newdir"];
      const before = await outside(layout);
      const env = layout.env();
      for (const [name, op] of Object.entries(DIR_OPS)) {
        for (const path of paths) {
          // A symlink inside work/ is the entry itself for remove: removing it removes the link, nothing outside.
          if (name === "remove" && (path === "link-dir" || path === "link-root")) continue;
          try {
            const result = await op(env, path);
            await closeIfOpened(result);
            refused(result, path);
          } catch (error) {
            throw new Error(`${name}(${path}): ${(error as Error).message}`);
          }
        }
      }
      assert.deepEqual(await outside(layout), before);
    });
  });

  it("a rename or move out of, into or across work/ is refused at either end", async () => {
    await withLayout(async (layout) => {
      const before = await outside(layout);
      const env = layout.env();
      await writeFile(join(layout.work, "a.txt"), "a");
      const cases: Array<[string, string, string]> = [
        ["a.txt", "../store/a.txt", "../store/a.txt"],
        ["a.txt", "../store/run.sqlite", "../store/run.sqlite"],
        ["a.txt", "link-dir/a.txt", "link-dir/a.txt"],
        ["a.txt", layout.sqlite, layout.sqlite],
        ["../store/run.sqlite", "stolen.sqlite", "../store/run.sqlite"],
        [layout.sqlite, "stolen.sqlite", layout.sqlite],
        ["link-dir/run.sqlite", "stolen.sqlite", "link-dir/run.sqlite"],
        ["../run.json", "run.json", "../run.json"],
      ];
      for (const [source, destination, named] of cases) {
        refused(await env.renameFile(source, destination, context), named);
      }
      assert.deepEqual(await outside(layout), before);
      assert.equal(await readFile(join(layout.work, "a.txt"), "utf8"), "a");
      assert.equal(existsSync(join(layout.work, "stolen.sqlite")), false);
    });
  });

  it("the workspace root itself cannot be removed or renamed, and nothing above it is reachable by cwd", async () => {
    await withLayout(async (layout) => {
      const env = layout.env();
      refused(await env.remove(layout.work, { recursive: true, force: true }, context), layout.work);
      refused(await env.remove(".", { recursive: true, force: true }, context), ".");
      refused(await env.renameFile(".", "gone", context), ".");
      assert.ok(existsSync(join(layout.work, "real.txt")));
      const escaped = layout.env({}, "../store");
      refused(await escaped.readTextFile("run.sqlite", context), "run.sqlite");
      assert.equal(getOrThrow(await layout.env({}, "sub").readTextFile("../real.txt", context)), "inside");
    });
  });

  it("covers every path-taking method of pi's NodeExecutionEnv, so a method pi adds fails here until it is confined", async () => {
    await withLayout(async (layout) => {
      const piMethods = Object.getOwnPropertyNames(NodeExecutionEnv.prototype).filter(
        (name) => name !== "constructor" && typeof (NodeExecutionEnv.prototype as unknown as Record<string, unknown>)[name] === "function",
      );
      const ours = new Set(Object.getOwnPropertyNames(Object.getPrototypeOf(layout.env())));
      // Lexical (no file system access), derived from a confined method, or a command rather than a file operation.
      const notFileOperations = new Set(["absolutePath", "joinPath", "exists", "readTextLines", "exec", "cleanup", "createTempDir", "createTempFile"]);
      for (const name of piMethods) assert.ok(ours.has(name) || notFileOperations.has(name), `${name} is neither confined nor listed`);
      for (const name of [...Object.keys(CONTENT_OPS), ...Object.keys(ENTRY_OPS), ...Object.keys(DIR_OPS), "renameFile"]) {
        const method = name === "createDirFlat" ? "createDir" : name;
        assert.ok(piMethods.includes(method), `${method} is a pi method`);
      }
    });
  });
});

describe("what stays allowed", () => {
  it("reads and writes inside work/ through `..` that stays inside, absolute paths and symlinks that point inside", async () => {
    await withLayout(async (layout) => {
      const env = layout.env();
      assert.equal(getOrThrow(await env.readTextFile("sub/../real.txt", context)), "inside");
      assert.equal(getOrThrow(await env.readTextFile(join(layout.work, "real.txt"), context)), "inside");
      assert.equal(getOrThrow(await env.readTextFile("inner-file", context)), "inside");
      assert.equal(getOrThrow(await env.readTextFile("inner-dir/f.txt", context)), "inside-dir");
      getOrThrow(await env.writeFile("inner-file", "changed through a link", context));
      assert.equal(await readFile(join(layout.work, "real.txt"), "utf8"), "changed through a link");
      getOrThrow(await env.writeFile("inner-dir/new.txt", "x", context));
      assert.equal(await readFile(join(layout.work, "real-dir", "new.txt"), "utf8"), "x");
      getOrThrow(await env.writeFile("deep/er/still/f.txt", "nested", context));
      assert.equal(await readFile(join(layout.work, "deep/er/still/f.txt"), "utf8"), "nested");
      getOrThrow(await env.appendFile("deep/er/still/f.txt", "+more", context));
      getOrThrow(await env.truncateFile("deep/er/still/f.txt", 3, context));
      getOrThrow(await env.flushFile("deep/er/still/f.txt", context));
      assert.equal(await readFile(join(layout.work, "deep/er/still/f.txt"), "utf8"), "nes");
      assert.deepEqual(getOrThrow(await env.listDir(".", context)).map((entry) => entry.name).includes("deep"), true);
      const info = getOrThrow(await env.fileInfo("deep", context));
      assert.deepEqual([info.name, info.kind, info.path], ["deep", "directory", join(layout.work, "deep")]);
    });
  });

  it("returns the real path in listings, file info, reader info and errors, never a /proc path", async () => {
    await withLayout(async (layout) => {
      const env = layout.env();
      const listing = getOrThrow(await env.listDir("real-dir", context));
      assert.deepEqual(listing.map((entry) => entry.path), [join(layout.work, "real-dir", "f.txt")]);
      const reader = getOrThrow(await env.openDirReader("real-dir", context));
      const page = getOrThrow(await reader.next(10, context));
      assert.deepEqual(page.entries.map((entry) => entry.path), [join(layout.work, "real-dir", "f.txt")]);
      await reader.close(context);
      const binary = getOrThrow(await env.openBinaryReader("real.txt", undefined, context));
      const info = getOrThrow(await binary.info(context));
      assert.deepEqual([info.name, info.path, info.size], ["real.txt", join(layout.work, "real.txt"), 6]);
      await binary.close(context);
      const missing = await env.readTextFile("nope/missing.txt", context);
      assert.ok(!missing.ok && missing.error.code === "not_found");
      assert.ok(!missing.error.message.includes("/proc/self/fd"), missing.error.message);
      const lstatFail = await env.fileInfo("nope/missing.txt", context);
      assert.ok(!lstatFail.ok && !lstatFail.error.message.includes("/proc/self/fd") && !(lstatFail.error.path ?? "").includes("/proc/self/fd"));
      const removeFail = await env.remove("nope/missing.txt", undefined, context);
      assert.ok(!removeFail.ok && !removeFail.error.message.includes("/proc/self/fd"), removeFail.ok ? "" : removeFail.error.message);
    });
  });

  it("operates on a symlink inside work/ as the link: stat, rename and remove never touch what it points at", async () => {
    await withLayout(async (layout) => {
      const env = layout.env();
      assert.equal(getOrThrow(await env.fileInfo("link-file", context)).kind, "symlink");
      getOrThrow(await env.renameFile("link-file", "renamed-link", context));
      assert.equal(await readlink(join(layout.work, "renamed-link")), "../store/run.sqlite");
      getOrThrow(await env.remove("renamed-link", undefined, context));
      getOrThrow(await env.remove("link-dir", undefined, context));
      getOrThrow(await env.remove("link-root", undefined, context));
      assert.equal(existsSync(join(layout.work, "link-dir")), false);
      assert.equal(await readFile(layout.sqlite, "utf8"), SQLITE);
      assert.ok(existsSync(join(layout.base, "run.json")));
      // Replacing a symlink as a rename destination replaces the link, not what it points at.
      await writeFile(join(layout.work, "new.txt"), "n");
      getOrThrow(await env.renameFile("new.txt", "link-abs", context));
      assert.equal(await readFile(layout.sqlite, "utf8"), SQLITE);
      assert.equal(await readFile(join(layout.work, "link-abs"), "utf8"), "n");
    });
  });

  it("lets file operations read the claim's tmp/ (the bash spill the model is told about) but never write it", async () => {
    await withLayout(async (layout) => {
      const spill = join(layout.base, "tmp", "tmp-x", "pi-output-1.log");
      await mkdir(join(layout.base, "tmp", "tmp-x"));
      await writeFile(spill, "spilled output");
      const env = layout.env();
      assert.equal(getOrThrow(await env.readTextFile(spill, context)), "spilled output");
      assert.equal(getOrThrow(await env.fileInfo(spill, context)).size, 14);
      assert.equal(getOrThrow(await env.listDir(join(layout.base, "tmp"), context)).length, 1);
      refused(await env.writeFile(spill, "x", context), spill);
      refused(await env.appendFile(spill, "x", context), spill);
      refused(await env.remove(spill, undefined, context), spill);
      refused(await env.createDir(join(layout.base, "tmp", "new"), undefined, context), join(layout.base, "tmp", "new"));
      assert.equal(await readFile(spill, "utf8"), "spilled output");
    });
  });

  it("reads a directory the app names in readRoots, never writes it", async () => {
    await withLayout(async (layout) => {
      const env = layout.env({ readRoots: [layout.elsewhere] });
      const secret = join(layout.elsewhere, "secret.txt");
      assert.equal(getOrThrow(await env.readTextFile(secret, context)), "SECRET");
      refused(await env.writeFile(secret, "x", context), secret);
      refused(await layout.env().readTextFile(secret, context), secret);
      refused(await env.readTextFile(layout.sqlite, context), layout.sqlite);
    });
  });

  it("does not widen when an agent swaps work/ or tmp/ for a symlink after the environment was built", async () => {
    await withLayout(async (layout) => {
      const factory = archilEnv(layout.claim, { noNewPrivs: false });
      const env = factory({});
      await writeFile(join(layout.elsewhere, "f.txt"), "elsewhere-file");
      await rm(join(layout.base, "tmp"), { recursive: true });
      await symlink("/", join(layout.base, "tmp"));
      const throughTmp = join(layout.base, "tmp", "etc", "hostname");
      refused(await env.readTextFile(throughTmp, context), throughTmp);
      await rename(layout.work, `${layout.work}.moved`);
      await symlink(layout.elsewhere, layout.work);
      refused(await env.readTextFile("f.txt", context), "f.txt");
      refused(await env.writeFile("g.txt", "x", context), "g.txt");
      assert.equal(existsSync(join(layout.elsewhere, "g.txt")), false);
    });
  });

  it("is left alone by confineFiles: false", async () => {
    await withLayout(async (layout) => {
      const env = layout.env({ confineFiles: false });
      assert.equal(getOrThrow(await env.readTextFile("../store/run.sqlite", context)), SQLITE);
    });
  });
});

/**
 * A view of an outcome that two environments can be compared by: codes and values, paths made relative to the layout.
 * Under a symlinked TMPDIR the layout's real path differs from the one the test names it by, and stays told apart
 * (`<real>`): a canonical path (canonicalPath's) is real in both, a listing names the layout as the test does.
 */
function normalize(layout: Layout, result: Result<unknown, FileError>): unknown {
  const real = realpathSync(layout.base);
  const text = (value: string) => value.split(layout.base).join("<base>").split(real).join("<real>");
  const value = (v: unknown): unknown => {
    if (typeof v === "string") return text(v);
    if (Array.isArray(v)) return v.map(value);
    if (v instanceof Uint8Array) return Buffer.from(v).toString("utf8");
    if (typeof v === "object" && v !== null && "close" in v) return "<handle>";
    if (typeof v === "object" && v !== null && "kind" in v && "path" in v) {
      const info = v as { name: string; path: string; kind: string; size: number };
      return { name: info.name, path: text(info.path), kind: info.kind, ...(info.kind === "file" ? { size: info.size } : {}) };
    }
    return v;
  };
  return result.ok ? { ok: true, value: value(result.value) } : { ok: false, code: result.error.code };
}

describe("a confined environment answers inside work/ like pi's own", () => {
  it("returns the same results and error codes over a battery of operations", async () => {
    const battery = async (layout: Layout, env: NodeExecutionEnv): Promise<unknown[]> => {
      const out: unknown[] = [];
      const note = async (label: string, result: Promise<Result<unknown, FileError>>) => {
        const settled = await result;
        await closeIfOpened(settled);
        out.push([label, normalize(layout, settled)]);
      };
      await note("read missing", env.readTextFile("missing.txt", context));
      await note("read dir", env.readTextFile("real-dir", context));
      await note("read through a file", env.readTextFile("real.txt/x", context));
      await note("write nested", env.writeFile("a/b/c.txt", "hello", context));
      await note("write through a file", env.writeFile("real.txt/x", "hello", context));
      await note("write onto dir", env.writeFile("real-dir", "hello", context));
      await note("read back", env.readTextFile("a/b/c.txt", context));
      await note("read binary", env.readBinaryFile("a/b/c.txt", context));
      await note("append", env.appendFile("a/b/c.txt", " world", context));
      await note("lines", env.readTextLines("a/b/c.txt", { maxLines: 1 }, context));
      await note("truncate", env.truncateFile("a/b/c.txt", 4, context));
      await note("truncate negative", env.truncateFile("a/b/c.txt", -1, context));
      await note("truncate missing", env.truncateFile("missing.txt", 1, context));
      await note("flush", env.flushFile("a/b/c.txt", context));
      await note("flush dir", env.flushFile("a", context));
      await note("flush missing", env.flushFile("missing.txt", context));
      await note("info dir", env.fileInfo("a/b", context));
      await note("info link", env.fileInfo("inner-file", context));
      await note("info missing", env.fileInfo("missing.txt", context));
      await note("exists", env.exists("a/b/c.txt", context));
      await note("exists missing", env.exists("missing.txt", context));
      await note("exists through a file", env.exists("real.txt/x", context));
      await note("list", env.listDir("real-dir", context));
      await note("list missing", env.listDir("missing", context));
      await note("list a file", env.listDir("real.txt", context));
      await note("dir reader missing", env.openDirReader("missing", context));
      await note("dir reader file", env.openDirReader("real.txt", context));
      await note("binary reader dir", env.openBinaryReader("real-dir", undefined, context));
      await note("binary reader missing", env.openBinaryReader("missing.txt", undefined, context));
      await note("binary reader nofollow link", env.openBinaryReader("inner-file", { noFollow: true }, context));
      await note("binary reader link", env.openBinaryReader("inner-file", undefined, context));
      await note("canonical link", env.canonicalPath("inner-file", context));
      await note("canonical missing", env.canonicalPath("missing.txt", context));
      await note("mkdir -p", env.createDir("n/m/o", undefined, context));
      await note("mkdir existing", env.createDir("n/m/o", { recursive: false }, context));
      await note("mkdir no parent", env.createDir("nope/x", { recursive: false }, context));
      await note("mkdir over file", env.createDir("real.txt", undefined, context));
      await note("rename", env.renameFile("a/b/c.txt", "n/moved.txt", context));
      await note("rename missing", env.renameFile("missing.txt", "n/x.txt", context));
      await note("rename onto dir", env.renameFile("n/moved.txt", "n/m", context));
      await note("remove dir", env.remove("n/m", undefined, context));
      await note("remove -r", env.remove("n", { recursive: true }, context));
      await note("remove missing", env.remove("missing.txt", undefined, context));
      await note("remove missing force", env.remove("missing.txt", { force: true }, context));
      await note("remove below missing force", env.remove("nope/deeper/missing.txt", { force: true }, context));
      await note("remove below missing", env.remove("nope/deeper/missing.txt", undefined, context));
      await note("list root", env.listDir(".", context));
      return out;
    };
    const run = (confineFiles: boolean) =>
      withLayout(async (layout) => battery(layout, layout.env({ confineFiles })));
    const confined = (await run(true)) as Array<[string, unknown]>;
    const plain = (await run(false)) as Array<[string, unknown]>;
    const differences = confined.flatMap((entry, index) => (JSON.stringify(entry) === JSON.stringify(plain[index]) ? [] : [{ confined: entry, pi: plain[index] }]));
    // The one place the answers differ: creating a directory where a file is in the way. pi's recursive mkdir reports
    // EEXIST (code `unknown`); the confined walk meets the file as a path component and reports `not_directory`.
    assert.deepEqual(
      differences.map(({ confined, pi }) => [confined[0], (confined[1] as { code: string }).code, (pi[1] as { code: string }).code]),
      [
        ["write through a file", "not_directory", "unknown"],
        ["mkdir over file", "not_directory", "unknown"],
      ],
    );
  });
});

/** Swaps a path for a symlink to the store in the window between the check and the open. */
async function raceWith(swap: () => Promise<void>, run: () => Promise<void>, onCheck = 1): Promise<void> {
  let checks = 0;
  confineHooks.afterCheck = async () => {
    if (++checks !== onCheck) return;
    confineHooks.afterCheck = undefined;
    await swap();
  };
  try {
    await run();
  } finally {
    confineHooks.afterCheck = undefined;
  }
}

describe("a component swapped for a symlink after the check is refused, never followed", () => {
  const swapFileForLink = (layout: Layout, name: string) => async () => {
    await rm(join(layout.work, name), { force: true });
    await symlink(layout.sqlite, join(layout.work, name));
  };

  for (const [name, op] of [
    ["writeFile", (env: NodeExecutionEnv) => env.writeFile("x", "PWNED", context)],
    ["appendFile", (env: NodeExecutionEnv) => env.appendFile("x", "PWNED", context)],
    ["truncateFile", (env: NodeExecutionEnv) => env.truncateFile("x", 0, context)],
    ["flushFile", (env: NodeExecutionEnv) => env.flushFile("x", context)],
    ["readTextFile", (env: NodeExecutionEnv) => env.readTextFile("x", context)],
    ["readBinaryFile", (env: NodeExecutionEnv) => env.readBinaryFile("x", context)],
    ["openTextLineReader", (env: NodeExecutionEnv) => env.openTextLineReader("x", context)],
  ] as const) {
    it(`the last component, ${name}`, async () => {
      await withLayout(async (layout) => {
        await writeFile(join(layout.work, "x"), "mine");
        const before = await outside(layout);
        let result: Result<unknown, FileError> | undefined;
        await raceWith(swapFileForLink(layout, "x"), async () => {
          result = await op(layout.env());
        });
        await closeIfOpened(result!);
        refused(result!, "x", "changed");
        assert.equal(await readFile(layout.sqlite, "utf8"), SQLITE);
        assert.deepEqual(await outside(layout), before);
      });
    });
  }

  it("the last component, openBinaryReader", async () => {
    await withLayout(async (layout) => {
      await writeFile(join(layout.work, "x"), "mine");
      let result: Result<unknown, FileError> | undefined;
      await raceWith(swapFileForLink(layout, "x"), async () => {
        result = await layout.env().openBinaryReader("x", undefined, context);
      });
      await closeIfOpened(result!);
      assert.ok(!result!.ok, "the reader was not opened on the store");
      assert.equal(await readFile(layout.sqlite, "utf8"), SQLITE);
    });
  });

  it("a directory above the target, for a write that creates a file in it", async () => {
    await withLayout(async (layout) => {
      await mkdir(join(layout.work, "a/b"), { recursive: true });
      const before = await outside(layout);
      let result: Result<unknown, FileError> | undefined;
      await raceWith(
        async () => {
          await rename(join(layout.work, "a"), join(layout.work, "a.moved"));
          await symlink(layout.store, join(layout.work, "a"));
        },
        async () => {
          result = await layout.env().writeFile("a/b/new.txt", "PWNED", context);
        },
      );
      refused(result!, "a/b/new.txt", "changed");
      assert.deepEqual(await outside(layout), before);
    });
  });

  it("a directory above the target, for a read and for a listing", async () => {
    await withLayout(async (layout) => {
      await mkdir(join(layout.work, "d"));
      await writeFile(join(layout.work, "d", "run.sqlite"), "mine");
      const swap = async () => {
        await rename(join(layout.work, "d"), join(layout.work, "d.moved"));
        await symlink(layout.store, join(layout.work, "d"));
      };
      let read: Result<unknown, FileError> | undefined;
      await raceWith(swap, async () => {
        read = await layout.env().readTextFile("d/run.sqlite", context);
      });
      refused(read!, "d/run.sqlite", "changed");
      await rm(join(layout.work, "d"));
      await rename(join(layout.work, "d.moved"), join(layout.work, "d"));
      let listing: Result<unknown, FileError> | undefined;
      await raceWith(swap, async () => {
        listing = await layout.env().listDir("d", context);
      });
      refused(listing!, "d", "changed");
    });
  });

  it("directories that the call is about to create", async () => {
    await withLayout(async (layout) => {
      const before = await outside(layout);
      for (const op of [
        (env: NodeExecutionEnv) => env.writeFile("new/deep/x.txt", "PWNED", context),
        (env: NodeExecutionEnv) => env.createDir("new/deep", undefined, context),
      ]) {
        let result: Result<unknown, FileError> | undefined;
        await raceWith(
          async () => {
            await symlink(layout.store, join(layout.work, "new"));
          },
          async () => {
            result = await op(layout.env());
          },
        );
        refused(result!, "new/deep", "changed");
        await rm(join(layout.work, "new"), { force: true });
      }
      assert.deepEqual(await outside(layout), before);
    });
  });

  it("the workspace root itself", async () => {
    await withLayout(async (layout) => {
      let result: Result<unknown, FileError> | undefined;
      await raceWith(
        async () => {
          await rename(layout.work, `${layout.work}.moved`);
          await symlink(layout.store, layout.work);
        },
        async () => {
          result = await layout.env().writeFile("x.txt", "PWNED", context);
        },
      );
      refused(result!, "x.txt", "changed");
      assert.deepEqual(await readdir(layout.store), ["run.sqlite"]);
      assert.equal(await readFile(layout.sqlite, "utf8"), SQLITE);
    });
  });

  it("either end of a rename, and a remove that finds a link: the link goes, what it pointed at stays", async () => {
    await withLayout(async (layout) => {
      await mkdir(join(layout.work, "d"));
      await writeFile(join(layout.work, "a.txt"), "a");
      const before = await outside(layout);
      let moved: Result<unknown, FileError> | undefined;
      // The second check is the destination's: the swap lands after both ends were resolved and before either is opened.
      await raceWith(
        async () => {
          await rm(join(layout.work, "d"), { recursive: true });
          await symlink(layout.store, join(layout.work, "d"));
        },
        async () => {
          moved = await layout.env().renameFile("a.txt", "d/b.txt", context);
        },
        2,
      );
      refused(moved!, "d/b.txt", "changed");
      assert.deepEqual(await outside(layout), before);
      await rm(join(layout.work, "d"));
      await writeFile(join(layout.work, "y"), "y");
      let removed: Result<unknown, FileError> | undefined;
      await raceWith(swapFileForLink(layout, "y"), async () => {
        removed = await layout.env().remove("y", undefined, context);
      });
      assert.ok(removed!.ok);
      assert.equal(await readFile(layout.sqlite, "utf8"), SQLITE);
    });
  });

  it("holds against a real concurrent swapper: the store is never written while a command flips the target between a file and a link", async (t) => {
    await withLayout(async (layout) => {
      const flip = spawnSwapper(layout.work, process.pid);
      const outcomes: Record<string, number> = { written: 0, refused: 0, failed: 0 };
      let stopped = false;
      try {
        const env = layout.env();
        const deadline = Date.now() + 2500;
        while (Date.now() < deadline) {
          const result = await env.writeFile("x", "PWNED", context);
          if (result.ok) outcomes.written++;
          else if (result.error instanceof PathOutsideWorkError) outcomes.refused++;
          else outcomes.failed++;
          const content = await readFile(layout.sqlite, "utf8");
          assert.equal(content, SQLITE, `the store was written after ${JSON.stringify(outcomes)}`);
        }
      } finally {
        // Before the layout is removed: a swapper still writing into work/ makes the removal fail (ENOTEMPTY).
        stopped = await stopSwapper(flip.pid!);
      }
      t.diagnostic(`outcomes ${JSON.stringify(outcomes)}`);
      assert.ok(stopped, "the swapper's group ended within its stop's deadline");
      assert.ok(outcomes.written + outcomes.refused > 0);
    });
  });
});

describe("the swapper fixture", () => {
  it("ends by itself when the test process that started it is killed mid-test, with no finally run", async () => {
    await withLayout(async (layout) => {
      const driver = spawn(process.execPath, [join(import.meta.dirname, "fixtures/swapper-driver.ts"), layout.work], { stdio: ["pipe", "pipe", "inherit"] });
      let said = "";
      driver.stdout.on("data", (chunk) => (said += chunk));
      let racer = 0;
      try {
        for (const t0 = Date.now(); !/"swapper":\d+/.test(said) && Date.now() - t0 < 20_000; ) await new Promise((r) => setTimeout(r, 20));
        racer = Number(/"swapper":(\d+)/.exec(said)?.[1]);
        assert.ok(racer > 0, "the driver started a swapper");
        assert.ok(alive(racer), "the swapper is running");
        driver.kill("SIGKILL");
        for (const t0 = Date.now(); alive(racer) && Date.now() - t0 < 5_000; ) await new Promise((r) => setTimeout(r, 20));
        assert.ok(!alive(racer), "the swapper is gone within 5 s of its test process");
      } finally {
        driver.kill("SIGKILL");
        // the swapper leads a group of its own: this is the group of the one this test started
        if (racer > 0) await stopSwapper(racer);
      }
    });
  });
});

describe("the swapper fixture's driver", () => {
  it("ends with the test process that started it, and the swapper with the driver, when that process is killed before it cleans up", async () => {
    await withLayout(async (layout) => {
      const outer = spawn(process.execPath, [join(import.meta.dirname, "fixtures/swapper-outer.ts"), layout.work], { stdio: ["pipe", "pipe", "inherit"] });
      let said = "";
      outer.stdout.on("data", (chunk) => (said += chunk));
      let pids: { driver: number; swapper: number } | undefined;
      try {
        for (const t0 = Date.now(); !/"swapper":\d+/.test(said) && Date.now() - t0 < 20_000; ) await new Promise((r) => setTimeout(r, 20));
        pids = JSON.parse(said.trim().split("\n")[0]!) as { driver: number; swapper: number };
        assert.ok(alive(pids.driver) && alive(pids.swapper), "the driver and the swapper are running");
        outer.kill("SIGKILL");
        for (const t0 = Date.now(); (alive(pids.driver) || alive(pids.swapper)) && Date.now() - t0 < 5_000; ) await new Promise((r) => setTimeout(r, 20));
        assert.ok(!alive(pids.driver), "the driver is gone within 5 s of the process that started it");
        assert.ok(!alive(pids.swapper), "the swapper is gone with it");
      } finally {
        outer.kill("SIGKILL");
        if (pids) {
          try {
            process.kill(pids.driver, "SIGKILL");
          } catch {}
          await stopSwapper(pids.swapper);
        }
      }
    });
  });
});

describe("the swapper fixture's stand-in test process", () => {
  it("ends, with the driver and the swapper, once its stdin from the test closes, so a killed test leaves none of the three", async () => {
    await withLayout(async (layout) => {
      const outer = spawn(process.execPath, [join(import.meta.dirname, "fixtures/swapper-outer.ts"), layout.work], { stdio: ["pipe", "pipe", "inherit"] });
      let said = "";
      outer.stdout.on("data", (chunk) => (said += chunk));
      let pids: { driver: number; swapper: number } | undefined;
      try {
        for (const t0 = Date.now(); !/"swapper":\d+/.test(said) && Date.now() - t0 < 20_000; ) await new Promise((r) => setTimeout(r, 20));
        pids = JSON.parse(said.trim().split("\n")[0]!) as { driver: number; swapper: number };
        const all = [outer.pid!, pids.driver, pids.swapper];
        assert.ok(all.every(alive), "the stand-in, the driver and the swapper are running");
        outer.stdin.end();
        for (const t0 = Date.now(); all.some(alive) && Date.now() - t0 < 5_000; ) await new Promise((r) => setTimeout(r, 20));
        assert.deepEqual(all.filter(alive), [], "all three are gone within 5 s of the test's end of the pipe closing");
      } finally {
        outer.kill("SIGKILL");
        if (pids) {
          try {
            process.kill(pids.driver, "SIGKILL");
          } catch {}
          await stopSwapper(pids.swapper);
        }
      }
    });
  });
});

/** A swapper's stand-in that, once stopped, writes late-0 to late-19 in `work`, one every 10 ms, and exits; `ready` says it is running. */
function lateSwapper(work: string, onStop = "n=0; while [ $n -lt 20 ]; do : > late-$n; n=$((n+1)); sleep 0.01; done; exit 0"): ChildProcess {
  return spawn("sh", ["-c", `cd ${work} && trap '${onStop}' TERM && : > ready && while :; do sleep 0.01; done`], { stdio: "ignore", detached: true });
}

describe("stopping a swapper", () => {
  const ready = async (work: string) => {
    for (const t0 = Date.now(); !existsSync(join(work, "ready")) && Date.now() - t0 < 10_000; ) await new Promise((r) => setTimeout(r, 10));
    assert.ok(existsSync(join(work, "ready")), "the swapper is running");
  };
  const late = async (work: string) => (await readdir(work)).filter((name) => name.startsWith("late-")).length;

  it("returns once nothing in its group runs: every write it makes after the stop signal is done, and none comes later", async () => {
    await withLayout(async (layout) => {
      const swapper = lateSwapper(layout.work);
      try {
        await ready(layout.work);
        assert.equal(await stopSwapper(swapper.pid!), true, "the group ended within the stop's deadline");
        assert.equal(await late(layout.work), 20, "every write the swapper made after the stop signal");
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(await late(layout.work), 20, "and nothing since");
      } finally {
        try {
          process.kill(-swapper.pid!, "SIGKILL");
        } catch {}
      }
    });
  });

  it("kills a group that outlives the grace, and waits for it", async () => {
    await withLayout(async (layout) => {
      const swapper = lateSwapper(layout.work, "");
      try {
        await ready(layout.work);
        const t0 = Date.now();
        assert.equal(await stopSwapper(swapper.pid!, 200), true, "the group ended once killed");
        assert.ok(Date.now() - t0 >= 200, "not before the grace ran out");
        assert.equal(groupRuns(swapper.pid!), false, "nothing in the group runs");
      } finally {
        try {
          process.kill(-swapper.pid!, "SIGKILL");
        } catch {}
      }
    });
  });
});

describe("stopping a swapper whose group holds only zombies", () => {
  it("counts it stopped at once: a zombie no one has reaped writes nothing", async () => {
    // A parent that cannot reap (its event loop is blocked): the child it started in a group of its own stays a zombie.
    const blocked = `const { spawn } = require("node:child_process");
      const child = spawn("sh", ["-c", "exit 0"], { stdio: "ignore", detached: true });
      require("node:fs").writeSync(1, child.pid + "\\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);`;
    const parent = spawn(process.execPath, ["-e", blocked], { stdio: ["ignore", "pipe", "inherit"] });
    try {
      let said = "";
      parent.stdout.on("data", (chunk) => (said += chunk));
      for (const t0 = Date.now(); !said.includes("\n") && Date.now() - t0 < 10_000; ) await new Promise((r) => setTimeout(r, 10));
      const zombie = Number(said.trim());
      assert.ok(zombie > 0, "the parent started its child");
      for (const t0 = Date.now(); alive(zombie) && Date.now() - t0 < 5_000; ) await new Promise((r) => setTimeout(r, 10));
      assert.ok(!alive(zombie), "the child has exited");
      assert.equal(await stopSwapper(zombie, 100, 100), true, "a group of zombies is stopped");
    } finally {
      parent.kill("SIGKILL");
    }
  });
});

describe("the swapper fixture's two ends", () => {
  it("carries both: the loop follows its test process, and a deadline bounds it whatever the test process does", async () => {
    assert.match(swapperLoop("/w", 4242), /while kill -0 4242 /);
    assert.ok(SWAPPER_CAP_SECONDS >= 60 && SWAPPER_CAP_SECONDS <= 300, "a cap longer than a test needs and short enough to matter");
    await withLayout(async (layout) => {
      const racer = spawnSwapper(layout.work, process.pid, 1);
      try {
        const gone = new Promise<void>((resolve) => racer.once("exit", () => resolve()));
        assert.ok(alive(racer.pid!), "the swapper runs while its test process is alive");
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            gone,
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error("the 1 s cap did not end the swapper within 6 s")), 6_000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        assert.ok(!alive(racer.pid!));
      } finally {
        await stopSwapper(racer.pid!);
      }
    });
  });
});

describe("through a pi Harness with a scripted model", () => {
  it("fails the model's write, edit and read of the store, the claim files and /etc as tool results, and the run continues", async () => {
    await withLayout(async (layout) => {
      const calls: Array<[string, JsonObject]> = [
        ["write", { path: "../store/run.sqlite", content: "PWNED" }],
        ["write", { path: layout.sqlite, content: "PWNED" }],
        ["edit", { path: "../run.json", edits: [{ oldText: "running", newText: "done" }] }],
        ["read", { path: "../owner.lock" }],
        ["read", { path: "link-dir/run.sqlite" }],
        ["write", { path: "link-root/etc/pda-escape", content: "x" }],
        ["write", { path: "ok.txt", content: "fine" }],
      ];
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses([
        ...calls.map(([name, args], index) => fauxAssistantMessage(fauxToolCall(name, args, { id: `call-${index}` }), { stopReason: "toolUse" })),
        fauxAssistantMessage("done"),
      ]);
      const registry = createRegistry();
      registry.install(ArchilCodingTools);
      const harness = await Harness.open(new MemoryStorage(), { models, registry, env: archilEnv(layout.claim, { noNewPrivs: false }) }, context);
      try {
        const model = faux.getModel();
        const conversation = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
        const settled = await (await conversation.submit({ type: "input", content: "go" }, context)).wait(context);
        assert.equal(settled.status, "done");
        const page = await conversation.entries({}, 100, undefined, context);
        const results = page.items.filter((entry) => entry.kind === "pi.tool-result").map((entry) => JSON.stringify(entry)).reverse();
        assert.equal(results.length, calls.length);
        for (const text of results.slice(0, -1)) {
          assert.match(text, /"isError":true/);
          assert.match(text, /outside the workspace/);
        }
        assert.doesNotMatch(results.at(-1)!, /"isError":true/);
      } finally {
        await harness.close(context);
      }
      assert.equal(await readFile(layout.sqlite, "utf8"), SQLITE);
      assert.equal(await readFile(join(layout.base, "run.json"), "utf8"), '{"status":"running"}');
      assert.equal(existsSync("/etc/pda-escape"), false);
      assert.equal(await readFile(join(layout.work, "ok.txt"), "utf8"), "fine");
    });
  });
});

describe("a run reached through a symlink", () => {
  it("names paths as the caller does, whatever characters the link's name holds ($& and $$ included)", async () => {
    const base = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "pda-confine-named-"));
    const named = join(base, "a$&b$$c");
    try {
      await mkdir(join(base, "real", "work"), { recursive: true });
      await symlink(join(base, "real"), named);
      const env = archilEnv({ root: named, work: join(named, "work") }, { noNewPrivs: false })({});
      getOrThrow(await env.writeFile("x.txt", "x", context));
      assert.equal(getOrThrow(await env.fileInfo("x.txt", context)).path, join(named, "work", "x.txt"));
      assert.deepEqual(getOrThrow(await env.listDir(".", context)).map((entry) => entry.path), [join(named, "work", "x.txt")]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("by path, the walk's last check", () => {
  it("knows a directory's path from the directory held once the path was swapped, and back", async () => {
    const base = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "pda-confine-held-"));
    const dir = join(base, "d");
    try {
      await mkdir(dir);
      const held = await open(dir, "r");
      try {
        assert.equal(await namesHeld(dir, held), true);
        await rename(dir, join(base, "d.held"));
        await symlink(join(base, "d.held"), dir); // a link to the directory held: the same inode, which realpath tells apart
        assert.equal(await namesHeld(dir, held), true, "a link to it names it; the walk's realpath check refuses the link");
        await rm(dir);
        await mkdir(dir);
        assert.equal(await namesHeld(dir, held), false, "another directory at the path");
        await rm(dir, { recursive: true });
        assert.equal(await namesHeld(dir, held), false, "nothing at the path");
      } finally {
        await held.close();
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("construction", () => {
  it("builds an environment for a claim whose directories do not exist yet, and confines it once they do", async () => {
    const base = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "pda-confine-late-"));
    try {
      const env = archilEnv({ root: join(base, "run"), work: join(base, "run", "work") }, { noNewPrivs: false })({});
      await mkdir(join(base, "run", "work"), { recursive: true });
      await mkdir(join(base, "run", "store"));
      await writeFile(join(base, "run", "store", "run.sqlite"), SQLITE);
      getOrThrow(await env.writeFile("f.txt", "ok", context));
      refused(await env.writeFile("../store/run.sqlite", "x", context), "../store/run.sqlite");
      assert.equal(await readFile(join(base, "run", "store", "run.sqlite"), "utf8"), SQLITE);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("is a typed EnvError when the pins cannot work", () => {
    assert.equal(new EnvError("PROC_UNAVAILABLE", "x").code, "PROC_UNAVAILABLE");
  });
});

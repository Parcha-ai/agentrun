// The server's flags for what the host tells the page about its agent: `--instructions-file F --instructions-mode replace|append` and `--without-extensions a,b`. A bad combination is an error
// at start (exit 2 from serve.ts), not a page that quietly runs the robot's instructions.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { appPolicyFromArgs } from "../app-policy.ts";

let dir: string;
let file: string;
before(() => {
  dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "app-policy-"));
  file = join(dir, "text.md");
  writeFileSync(file, "You are a poet.\n");
});
after(() => rmSync(dir, { recursive: true, force: true }));

describe("appPolicyFromArgs", () => {
  it("no flags: no policy, the page is the robot page", () => {
    assert.equal(appPolicyFromArgs({}), undefined);
  });
  it("a file with its mode is the instructions as the file has them", () => {
    assert.deepEqual(appPolicyFromArgs({ file, mode: "replace" }), { instructions: { mode: "replace", text: "You are a poet.\n" } });
    assert.deepEqual(appPolicyFromArgs({ file, mode: "append" }), { instructions: { mode: "append", text: "You are a poet.\n" } });
  });
  it("extensions to leave out are split on commas, trimmed, and may come with or without instructions", () => {
    assert.deepEqual(appPolicyFromArgs({ without: " robot-tools, computer ,," }), { withoutExtensions: ["robot-tools", "computer"] });
    assert.deepEqual(appPolicyFromArgs({ file, mode: "replace", without: "computer" }), { instructions: { mode: "replace", text: "You are a poet.\n" }, withoutExtensions: ["computer"] });
  });
  // The cases build their arguments inside the test, after the hook has made the directory (not while the suite is being registered).
  const cases: [string, () => { file?: string; mode?: string; without?: string }, RegExp][] = [
    ["a file with no mode", () => ({ file }), /--instructions-file needs --instructions-mode replace\|append/],
    ["a mode with no file", () => ({ mode: "replace" }), /--instructions-mode needs --instructions-file/],
    ["a mode that is neither", () => ({ file, mode: "merge" }), /--instructions-mode merge: replace or append/],
    ["a file that is not there", () => ({ file: join(dir, "nope.md"), mode: "replace" }), /cannot read/],
    ["an empty file", () => { writeFileSync(join(dir, "empty.md"), " \n"); return { file: join(dir, "empty.md"), mode: "append" }; }, /is empty/],
    ["an empty list of extensions", () => ({ without: " , " }), /--without-extensions .* names/],
  ];
  for (const [name, args, message] of cases) {
    it(`${name} is an error that says what to fix`, () => assert.throws(() => appPolicyFromArgs(args()), message));
  }
});

const serve = join(dirname(fileURLToPath(import.meta.url)), "..", "serve.ts");
const run = (...args: string[]) => spawnSync(process.execPath, [serve, "--model", "m", "--model-url", "http://127.0.0.1:9/v1", ...args], { encoding: "utf8", timeout: 30_000 });

describe("serve.ts refuses a bad app policy before anything starts", () => {
  it("a file without a mode: exit 2 and the message", () => {
    const r = run("--instructions-file", file);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--instructions-file needs --instructions-mode/);
  });
  it("a mode that is neither replace nor append: exit 2", () => {
    const r = run("--instructions-file", file, "--instructions-mode", "merge");
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /replace or append/);
  });
});

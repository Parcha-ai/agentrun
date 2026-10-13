// A generic extra of the cloud app (appExtra): files in the VM's bundle, the module that DEMO_APP_EXTRA names, extra environment, secret files for the run user (mode 0400, never in a log or a
// command), and no robot code for a page that is not about the robot. The robot's own extra is the default and does not change.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appExtraPlan, stageExtraSecrets, EXTRA_SECRETS_DIR } from "../modal-cloud.ts";
import { modalOptionsFromArgs } from "../cloud-module.ts";

test("with no extra and no robot, the bundle and the environment are the app's own", () => {
  assert.deepEqual(appExtraPlan({}), { bundleFiles: {}, env: {} });
});

test("the robot's own extra is the default, unchanged: its files and DEMO_APP_EXTRA", () => {
  const plan = appExtraPlan({ robot: true });
  assert.ok(Object.keys(plan.bundleFiles).includes("robot/vm/robot-extra.ts"));
  assert.match(plan.env.DEMO_APP_EXTRA!, /\/robot\/vm\/robot-extra\.ts$/);
  assert.equal(plan.env.DEMO_ROBOT_CODE, undefined);
});

test("an extra adds its files to the bundle, names its module, adds its environment, and can turn the robot's code off", () => {
  const plan = appExtraPlan({ appExtra: { module: "page/extra.ts", files: { "page/extra.ts": "/srv/extra.ts", "page/tools.ts": "/srv/tools.ts" }, env: { PAGE_MODE: "chat", PAGE_NAME: "x" }, robotCode: false } });
  assert.deepEqual(plan.bundleFiles, { "page/extra.ts": "/srv/extra.ts", "page/tools.ts": "/srv/tools.ts" });
  assert.match(plan.env.DEMO_APP_EXTRA!, /\/page\/extra\.ts$/);
  assert.equal(plan.env.PAGE_MODE, "chat");
  assert.equal(plan.env.DEMO_ROBOT_CODE, "0");
  assert.equal(plan.env.DEMO_EXTRA_SECRETS, undefined, "no secret files: no directory named");
});

test("an extra with secret files tells the app where they are, and refuses what would override the app's own wiring or leave the bundle", () => {
  assert.equal(appExtraPlan({ appExtra: { module: "p/e.ts", files: { "p/e.ts": "/a" }, secretFiles: { "api.key": "/run/secrets/k" } } }).env.DEMO_EXTRA_SECRETS, EXTRA_SECRETS_DIR);
  for (const name of ["DEMO_APP_EXTRA", "DEMO_LINK_TOKEN", "DEMO_MODEL", "DEMO_SWITCH_ID", "DEMO_ROBOT_CODE", "DEMO_EXTRA_SECRETS", "NODE_OPTIONS"]) {
    assert.throws(() => appExtraPlan({ appExtra: { module: "p/e.ts", files: { "p/e.ts": "/a" }, env: { [name]: "x" } } }), /reserved/, name);
  }
  assert.throws(() => appExtraPlan({ appExtra: { module: "p/missing.ts", files: { "p/e.ts": "/a" } } }), /module .* is not in the files/);
  assert.throws(() => appExtraPlan({ appExtra: { module: "../e.ts", files: { "../e.ts": "/a" } } }), /stay inside the bundle/);
  assert.throws(() => appExtraPlan({ appExtra: { module: "p/e.ts", files: { "p/e.ts": "/a" }, secretFiles: { "../etc/passwd": "/x" } } }), /secret file name/);
  assert.throws(() => appExtraPlan({ appExtra: { module: "p/e.ts", files: { "p/e.ts": "/a" }, secretFiles: { "a/b": "/x" } } }), /secret file name/);
});

test("an extra is refused on the pipe transport, which builds its own tools and would ignore it, before any box starts", () => {
  const extra = { module: "p/e.ts", files: { "p/e.ts": "/a" } };
  assert.throws(() => appExtraPlan({ transport: "pipe", appExtra: extra }), /appExtra needs the mount transport/);
  assert.doesNotThrow(() => appExtraPlan({ transport: "mount", appExtra: extra }));
  assert.doesNotThrow(() => appExtraPlan({ transport: "pipe" }), "no extra: the pipe transport is as it was");
  assert.throws(() => modalOptionsFromArgs({ transport: "pipe", "extra-module": "/etc/hostname" }), /extra-module needs the mount transport/);
});

test("with the robot on, the module may be the robot's own extra without supplying it, and the caller's secrets and environment are kept", () => {
  const plan = appExtraPlan({ robot: true, appExtra: { module: "robot/vm/robot-extra.ts", secretFiles: { token: "/s" }, env: { PAGE_MODE: "x" } } });
  assert.match(plan.env.DEMO_APP_EXTRA!, /\/robot\/vm\/robot-extra\.ts$/);
  assert.equal(plan.env.PAGE_MODE, "x");
  assert.ok(plan.env.DEMO_EXTRA_SECRETS);
  assert.ok("robot/vm/robot-extra.ts" in plan.bundleFiles);
  assert.throws(() => appExtraPlan({ appExtra: { module: "robot/vm/robot-extra.ts" } }), /is not in the files/, "without the robot on, it is not there");
  assert.throws(() => appExtraPlan({ robot: true, appExtra: { module: "../x.ts", files: { "../x.ts": "/a" } } }), /inside the bundle/);
});

test("an extra cannot overwrite a file the app's bundle already has", () => {
  for (const name of ["cloud-app.ts", "agent.ts", "pipe/gpu-rpc.ts", "package.json", "node_modules/ws/index.js", "pi-durable-disk-0.1.0.tgz"]) {
    assert.throws(() => appExtraPlan({ appExtra: { module: "p/e.ts", files: { "p/e.ts": "/a", [name]: "/x" } } }), /already used by the app bundle/, name);
  }
  assert.throws(() => appExtraPlan({ appExtra: { module: "cloud-app.ts", files: { "cloud-app.ts": "/a" } } }), /already used by the app bundle/, "not even as the module");
  assert.throws(() => appExtraPlan({ robot: true, appExtra: { module: "p/e.ts", files: { "p/e.ts": "/a", "robot/vm/robot-extra.ts": "/x" } } }), /already used by the app bundle/, "nor the robot's own files");
  assert.doesNotThrow(() => appExtraPlan({ appExtra: { module: "extra/page.mjs", files: { "extra/page.mjs": "/a", "extra/data/tools.mjs": "/b" } } }));
});

test("secret files are staged as bytes, mode 0400 for the run user, and the secret is in no command and no log line", async () => {
  const SECRET = "sk-test-0123456789abcdefghijklmnopqrstuvwxyz";
  const uploads: { path: string; text: string }[] = [];
  const commands: string[] = [];
  const logs: string[] = [];
  const client = {
    upload: async (_box: unknown, path: string, bytes: Uint8Array) => void uploads.push({ path, text: new TextDecoder().decode(bytes) }),
    exec: async (_box: unknown, command: string) => (commands.push(command), { exitCode: 0, result: "" }),
  };
  await stageExtraSecrets(client as never, { id: "sb-1", name: "box-1" } as never, { "api.key": "/run/secrets/api" }, { stage: "/tmp/stage", etc: "/etc/pda-demo", user: "pda" }, (m: string, d?: Record<string, unknown>) => logs.push(`${m} ${JSON.stringify(d ?? {})}`), (path: string) => (path === "/run/secrets/api" ? Buffer.from(SECRET) : (() => { throw new Error("unexpected read"); })()));
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0]!.text, SECRET, "the bytes go up as a file");
  assert.match(uploads[0]!.path, /^\/tmp\/stage\//);
  const run = commands.join("\n");
  assert.match(run, /install -m 0400 -o pda -g pda \x27\/tmp\/stage\/[^ ]+\x27 \x27\/etc\/pda-demo\/extra\/api\.key\x27/, "mode 0400, owned by the run user, in the extra directory");
  assert.ok(/install -d -m 0700 -o pda -g pda \x27\/etc\/pda-demo\/extra\x27/.test(run), "the directory is the run user's, so an extra can delete a file once read");
  assert.match(run, /rm -f \x27\/tmp\/stage\//, "the staged copy is removed");
  for (const text of [run, ...logs]) assert.equal(text.includes(SECRET), false, "the secret appears nowhere in a command or a log line");
  assert.ok(logs.some((l) => l.includes("api.key")), "the log names the file, never its content");
});

test("an unreadable secret file stops the start naming the file by its name, not its content", async () => {
  const client = { upload: async () => undefined, exec: async () => ({ exitCode: 0, result: "" }) };
  await assert.rejects(
    stageExtraSecrets(client as never, { id: "sb-1", name: "box-1" } as never, { "api.key": "/run/secrets/missing" }, { stage: "/tmp/stage", etc: "/etc/pda-demo", user: "pda" }, () => undefined, () => { throw Object.assign(new Error("ENOENT: no such file, open '/run/secrets/missing'"), { code: "ENOENT" }); }),
    /api\.key: cannot read its source file \(ENOENT\)/,
  );
});

test("--cloud-arg extra-module, extra-secrets and robot-code make the extra", () => {
  const dir = mkdtempSync(join(tmpdir(), "extra-secrets-"));
  try {
    writeFileSync(join(dir, "tunnel.url"), "https://example.invalid");
    writeFileSync(join(dir, "serve.key"), "k1");
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "ignored"), "x");
    const where = mkdtempSync(join(tmpdir(), "extra-module-"));
    const module = join(where, "page-extra.mjs");
    writeFileSync(module, "export default () => ({});");
    const options = modalOptionsFromArgs({ "extra-module": module, "extra-secrets": dir, "robot-code": "false" });
    assert.equal(options.appExtra?.module, "extra/page-extra.mjs", "published inside the bundle under its own name");
    assert.deepEqual(options.appExtra?.files, { "extra/page-extra.mjs": module });
    assert.deepEqual(options.appExtra?.secretFiles, { "serve.key": join(dir, "serve.key"), "tunnel.url": join(dir, "tunnel.url") }, "each regular file directly in the directory, no recursion");
    assert.equal(options.appExtra?.robotCode, false);
    assert.equal(modalOptionsFromArgs({}).appExtra, undefined);
    assert.throws(() => modalOptionsFromArgs({ "extra-secrets": dir }), /need extra-module/);
    assert.throws(() => modalOptionsFromArgs({ "robot-code": "false" }), /need extra-module/);
    assert.throws(() => modalOptionsFromArgs({ "extra-module": join(dir, "absent.mjs") }), /extra-module=.* is not a file/);
    assert.throws(() => modalOptionsFromArgs({ "extra-module": module, "robot-code": "maybe" }), /true or false/);
    assert.throws(() => modalOptionsFromArgs({ "extra-module": module, "extra-secrets": join(dir, "absent") }), /extra-secrets=.* is not a directory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

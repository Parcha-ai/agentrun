// OpenCode is the host's install (a pinned devDependency here, an optional peer of the server elsewhere): the adapter checks
// the binary it would run against the pins, and refuses a mismatch with a typed error a host maps to the run's failure
// line. The pin is exact: the session's records hold OpenCode's own event log, whose shape any release may change.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { findOpenCode, openCodePackages } from "../dist/harness-opencode/binary.js";
import { openCodePins, verifyOpenCode, verifyOpenCodeBinary } from "../dist/harness-opencode/verify.js";
import { OPENCODE_BINARY_SHA256, OPENCODE_INSTALL, OPENCODE_NPM_INTEGRITY, OPENCODE_VERSION, OpenCodeNotInstalled, OpenCodePinMismatch } from "../dist/harness-opencode/versions.js";

const ROOT = mkdtempSync(join(tmpdir(), "agentrun-opencode-pins-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));
/** An executable that prints `output` when asked its version. */
function cli(name, output) {
  const path = join(ROOT, name);
  writeFileSync(path, `#!/bin/sh\necho "${output}"\n`);
  chmodSync(path, 0o755);
  return { path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
}
const mismatch = (pin, expected, found) => (e) => e instanceof OpenCodePinMismatch && e.code === "OPENCODE_PIN_MISMATCH" && e.pin === pin && e.expected === expected && e.found === found;
const notInstalled = (e) => e instanceof OpenCodeNotInstalled && e.code === "OPENCODE_NOT_INSTALLED";

test("the pin is OpenCode 1.19.5 exactly, with the npm integrity of the launcher and every platform package, and a binary sha256 for Linux x64's", () => {
  assert.equal(OPENCODE_VERSION, "1.19.5");
  assert.equal(OPENCODE_INSTALL, "npm install --save-exact opencode-ai@1.19.5");
  assert.equal(Object.keys(OPENCODE_NPM_INTEGRITY).length, 13, "the launcher and its twelve platform packages");
  for (const integrity of Object.values(OPENCODE_NPM_INTEGRITY)) assert.match(integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
  for (const pkg of ["opencode-linux-x64", "opencode-linux-x64-baseline"]) assert.match(OPENCODE_BINARY_SHA256[pkg] ?? "", /^[0-9a-f]{64}$/, pkg);
  assert.deepEqual(openCodePins(), { version: "1.19.5", sha256: OPENCODE_BINARY_SHA256 });
});

test("the platform packages a machine may run are the launcher's own, in the order its postinstall tries them", () => {
  assert.deepEqual(openCodePackages("darwin", "arm64"), ["opencode-darwin-arm64"]);
  assert.deepEqual(openCodePackages("win32", "arm64"), ["opencode-windows-arm64"]);
  assert.deepEqual(openCodePackages("freebsd", "x64"), []);
  for (const pkg of openCodePackages()) assert.ok(pkg in OPENCODE_NPM_INTEGRITY, pkg);
});

test("the repository's lockfile installs exactly the pinned launcher and platform packages (version and npm sha512)", () => {
  const lock = JSON.parse(readFileSync(new URL("../../../package-lock.json", import.meta.url), "utf8")).packages;
  for (const [name, integrity] of Object.entries(OPENCODE_NPM_INTEGRITY)) {
    const entry = lock[`node_modules/${name}`];
    assert.ok(entry, `${name} is in the lockfile`);
    assert.equal(entry.version, OPENCODE_VERSION, name);
    assert.equal(entry.integrity, integrity, name);
  }
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.peerDependencies["opencode-ai"], OPENCODE_VERSION, "an exact peer of the server");
  assert.equal(manifest.peerDependenciesMeta["opencode-ai"].optional, true);
  assert.equal(manifest.devDependencies["opencode-ai"], OPENCODE_VERSION);
});

test("a binary whose sha256 is not the pinned build's is refused, typed, with the pin, what was expected and what was found", () => {
  const other = cli("other", "1.19.5");
  const result = verifyOpenCodeBinary({ path: other.path, pkg: "opencode-linux-x64" }, { version: "1.19.5", sha256: { "opencode-linux-x64": "f".repeat(64) } });
  assert.ok(mismatch("binary_sha256", "f".repeat(64), other.sha256)(result), String(result));
  assert.equal(result.path, other.path);
});

test("a binary OPENCODE_BIN names, with no platform package, is checked against the pins of this machine's packages", { skip: !openCodePackages().some((pkg) => OPENCODE_BINARY_SHA256[pkg]) && "no pinned sha256 for this machine's packages" }, () => {
  const other = cli("named", "1.19.5");
  const result = verifyOpenCodeBinary({ path: other.path });
  assert.ok(result instanceof OpenCodePinMismatch && result.pin === "binary_sha256" && result.found === other.sha256, String(result));
});

test("a binary that reports another version is refused, typed; the pinned one passes", () => {
  const newer = cli("newer", "1.19.6");
  assert.ok(mismatch("version", "1.19.5", "1.19.6")(verifyOpenCodeBinary({ path: newer.path }, { version: "1.19.5", sha256: {} })));
  const odd = cli("odd", "not opencode");
  assert.ok(mismatch("version", "1.19.5", "\"not opencode\"")(verifyOpenCodeBinary({ path: odd.path }, { version: "1.19.5", sha256: {} })));
  const right = cli("right", "1.19.5");
  assert.deepEqual(verifyOpenCodeBinary({ path: right.path, pkg: "opencode-linux-x64" }, { version: "1.19.5", sha256: { "opencode-linux-x64": right.sha256 } }), { path: right.path });
});

test("a platform package of another release is refused before the binary is read", () => {
  const right = cli("pkg", "1.19.5");
  assert.ok(mismatch("package_version", "1.19.5", "1.19.6")(verifyOpenCodeBinary({ path: right.path, pkg: "opencode-linux-x64", packageVersion: "1.19.6" }, { version: "1.19.5", sha256: {} })));
});

test("no binary, a path with no file, or a file that cannot run is \"not installed\", typed, naming the install line", () => {
  for (const found of [undefined, { path: join(ROOT, "missing") }]) {
    const result = verifyOpenCodeBinary(found);
    assert.ok(notInstalled(result), String(result));
    assert.match(result.message, /npm install --save-exact opencode-ai@1\.19\.5/);
  }
  const notRunnable = join(ROOT, "not-runnable");
  writeFileSync(notRunnable, "data");
  // No sha256 pin here: what is checked is that it runs.
  assert.ok(notInstalled(verifyOpenCodeBinary({ path: notRunnable }, { version: "1.19.5", sha256: {} })));
  assert.throws(() => verifyOpenCode({ path: join(ROOT, "missing-too") }), notInstalled);
  assert.throws(() => verifyOpenCode({ path: cli("thrown", "1.0.0").path }, { version: "1.19.5", sha256: {} }), mismatch("version", "1.19.5", "1.0.0"));
});

test("this machine's installed OpenCode is the pinned build: its package version, sha256 and reported version", { skip: !findOpenCode()?.packageVersion && "no OpenCode platform package installed here" }, () => {
  const found = findOpenCode();
  assert.equal(found.packageVersion, "1.19.5");
  assert.deepEqual(verifyOpenCode(found), { path: found.path });
});

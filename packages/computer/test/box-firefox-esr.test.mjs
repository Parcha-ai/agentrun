// Firefox ESR on a base whose apt has none (Ubuntu 24.04, whose firefox is a snap): box/install.sh's desktop step takes
// it from Mozilla's APT repository, the repository's key held to Mozilla's published fingerprint, and apt pinned so
// that repository supplies firefox-esr's own packages and nothing else. install.sh's steps run here as written, with
// its fixed paths moved into a scratch folder and apt, curl and gpg stubbed on PATH: no network, no root, no apt.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const INSTALL = readFileSync(new URL("../box/install.sh", import.meta.url), "utf8");
/** install.sh's definitions: everything before its dispatch on the arguments, which runs the steps. */
const DEFINITIONS = INSTALL.slice(0, INSTALL.indexOf('\ncase "$*" in\n'));
/** Mozilla's APT signing key, as packages.mozilla.org/apt publishes its fingerprint. */
const MOZILLA_FPR = "35BAA0B33E9EB396F59CA838C0BA5CE6DC6315A3";
const KEY_URL = "https://packages.mozilla.org/apt/repo-signing-key.gpg";
/** What apt-cache policy prints for firefox-esr: Ubuntu 24.04's (a name other packages refer to, no version), Debian's. */
const NO_CANDIDATE = "firefox-esr:\n  Installed: (none)\n  Candidate: (none)\n  Version table:\n";
const DEBIAN_CANDIDATE = "firefox-esr:\n  Installed: (none)\n  Candidate: 153.8.0esr-1~deb13u1\n  Version table:\n     153.8.0esr-1~deb13u1 500\n        500 http://deb.debian.org/debian trixie/main amd64 Packages\n";
/** gpg --show-keys --with-colons of one key: its primary key's fingerprint, then a subkey's, which is never the one checked. */
const shown = (...fingerprints) =>
  fingerprints.map((fpr) => `pub:-:2048:1:${fpr.slice(-16)}:1620162483:::-:::scSC::::::23::0:\nfpr:::::::::${fpr}:\nuid:-::::1620162483::0::Artifact Registry Repository Signer::::::::::0:\nsub:-:2048:1:00000000000000AA:1620162483::::::e::::::23:\nfpr:::::::::00000000000000000000000000000000000000AA:\n`).join("");

/** A stub on PATH: a shell script that logs its name and arguments, one line a call, then runs body. */
const stub = (bin, name, body) => {
  writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >>"$STUB_LOG"\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
};

/**
 * install.sh's mozilla_apt step, run as its definitions write it, with the Mozilla paths moved into a scratch folder.
 * policy: what apt-cache policy firefox-esr prints; keys: what gpg --show-keys prints of the fetched key.
 */
function run(t, { policy, keys = shown(MOZILLA_FPR) }) {
  const dir = mkdtempSync(join(tmpdir(), "computer-box-firefox-esr-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "calls");
  writeFileSync(join(dir, "policy"), policy);
  writeFileSync(join(dir, "keys"), keys);
  stub(bin, "apt-cache", `echo "apt-cache LC_ALL=\${LC_ALL-}" >>"$STUB_LOG"\ncat "${join(dir, "policy")}"`);
  stub(bin, "apt-get", "");
  // curl writes the key where -o says, as the real one would.
  stub(bin, "curl", 'while [ $# -gt 0 ]; do [ "$1" != -o ] || out=$2; shift; done\necho "fake key" >"$out"');
  stub(bin, "gpg", `cat "${join(dir, "keys")}"`);
  const paths = {
    MOZILLA_KEY: ["/etc/apt/keyrings/packages.mozilla.org.asc", join(dir, "etc/apt/keyrings/packages.mozilla.org.asc")],
    MOZILLA_LIST: ["/etc/apt/sources.list.d/mozilla.list", join(dir, "etc/apt/sources.list.d/mozilla.list")],
    MOZILLA_PIN: ["/etc/apt/preferences.d/mozilla", join(dir, "etc/apt/preferences.d/mozilla")],
  };
  let script = DEFINITIONS;
  for (const [name, [shipped, here]] of Object.entries(paths)) {
    assert.ok(script.includes(`\n${name}=${shipped}\n`), `install.sh fixes ${name}=${shipped}`);
    script = script.replace(`\n${name}=${shipped}\n`, `\n${name}=${here}\n`);
  }
  mkdirSync(join(dir, "etc/apt/sources.list.d"), { recursive: true });
  mkdirSync(join(dir, "etc/apt/preferences.d"));
  const ran = spawnSync("sh", ["-c", `${script}\nmozilla_apt\n`], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, STUB_LOG: log, LANG: "de_DE.UTF-8" } });
  const read = (name) => (existsSync(paths[name][1]) ? readFileSync(paths[name][1], "utf8") : undefined);
  return {
    status: ran.status,
    stderr: ran.stderr,
    calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
    key: read("MOZILLA_KEY"),
    list: read("MOZILLA_LIST"),
    pin: read("MOZILLA_PIN"),
    keyPath: paths.MOZILLA_KEY[1],
  };
}

/** The pin: packages.mozilla.org supplies firefox-esr and its own firefox-esr-* packages, and nothing else, at -1. */
const PIN = "Package: firefox-esr*\nPin: origin packages.mozilla.org\nPin-Priority: 500\n\nPackage: *\nPin: origin packages.mozilla.org\nPin-Priority: -1\n";

test("where apt has no firefox-esr candidate, the desktop step adds Mozilla's repository: the key fetched over https and checked by fingerprint, the source signed by it alone, and apt pinned to firefox-esr's packages from it", (t) => {
  const ran = run(t, { policy: NO_CANDIDATE });
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(ran.calls.slice(0, 2), ["apt-cache policy firefox-esr", "apt-cache LC_ALL=C"], "apt's own words for the candidate, read in the C locale");
  assert.equal(ran.calls[2], "apt-get install -y -qq --no-install-recommends gnupg", "gpg, on this path alone");
  assert.equal(ran.calls[3], `curl -fsSL --proto =https -o ${ran.keyPath} ${KEY_URL}`, "the key over https alone, no redirect to anything else");
  assert.match(ran.calls[4], new RegExp(`^gpg --homedir \\S+ --quiet --show-keys --with-colons ${ran.keyPath}$`), "the key read, never imported into a keyring");
  assert.equal(ran.calls[5], "apt-get update -qq", "apt reads the new source before the desktop's install");
  assert.equal(ran.calls.length, 6);
  assert.equal(ran.key, "fake key\n");
  assert.equal(ran.list, `deb [signed-by=${ran.keyPath}] https://packages.mozilla.org/apt mozilla main\n`);
  assert.equal(ran.pin, PIN);
});

test("a firefox-esr name apt has never heard of takes the same path as Ubuntu's no-candidate", (t) => {
  const ran = run(t, { policy: "" });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.list, `deb [signed-by=${ran.keyPath}] https://packages.mozilla.org/apt mozilla main\n`);
  assert.equal(ran.pin, PIN);
});

test("where apt has a firefox-esr candidate (Debian's), the Mozilla path is never touched: no fetch, no gpg, no source, no pin", (t) => {
  const ran = run(t, { policy: DEBIAN_CANDIDATE });
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(ran.calls, ["apt-cache policy firefox-esr", "apt-cache LC_ALL=C"]);
  assert.equal(ran.key, undefined);
  assert.equal(ran.list, undefined);
  assert.equal(ran.pin, undefined);
});

test("a key whose fingerprint is not Mozilla's stops the build, naming both fingerprints, with no source added and the key taken away", (t) => {
  const other = "0123456789ABCDEF0123456789ABCDEF01234567";
  const ran = run(t, { policy: NO_CANDIDATE, keys: shown(other) });
  assert.notEqual(ran.status, 0);
  assert.ok(ran.stderr.includes(other) && ran.stderr.includes(MOZILLA_FPR), ran.stderr);
  assert.equal(ran.list, undefined);
  assert.equal(ran.pin, undefined);
  assert.equal(ran.key, undefined, "the unchecked key is not left where a later source could name it");
  assert.ok(!ran.calls.includes("apt-get update -qq"), "apt never reads a source signed by it");
});

test("a key file holding a second key beside Mozilla's is refused too: signed-by trusts every key in the file", (t) => {
  const ran = run(t, { policy: NO_CANDIDATE, keys: shown(MOZILLA_FPR, "0123456789ABCDEF0123456789ABCDEF01234567") });
  assert.notEqual(ran.status, 0);
  assert.ok(ran.stderr.includes(MOZILLA_FPR), ran.stderr);
  assert.equal(ran.list, undefined);
  assert.equal(ran.key, undefined);
});

test("a key gpg reads nothing from is refused, in words", (t) => {
  const ran = run(t, { policy: NO_CANDIDATE, keys: "" });
  assert.notEqual(ran.status, 0);
  assert.ok(ran.stderr.includes(MOZILLA_FPR), ran.stderr);
  assert.equal(ran.list, undefined);
});

test("the desktop step runs the Mozilla step after apt's update and before its install, and the step writes only through its fixed paths", () => {
  const desktop = INSTALL.match(/^desktop\(\) \{\n([^]*?)^\}$/m)?.[1] ?? "";
  const lines = desktop.split("\n").map((line) => line.trim());
  const update = lines.indexOf("apt-get update -qq");
  const mozilla = lines.indexOf("mozilla_apt");
  const install = lines.findIndex((line) => line.startsWith("DEBIAN_FRONTEND=noninteractive apt-get install"));
  assert.ok(update >= 0 && update < mozilla && mozilla < install, "update, then the Mozilla step, then the install");
  assert.ok(INSTALL.includes(`\nMOZILLA_FPR=${MOZILLA_FPR}\n`), "the published fingerprint, pinned");
  const step = INSTALL.match(/^mozilla_apt\(\) \{\n([^]*?)^\}$/m)?.[1] ?? "";
  assert.ok(step, "install.sh has the step mozilla_apt()");
  assert.ok(!step.includes("/etc/apt"), "every path through MOZILLA_KEY, MOZILLA_LIST and MOZILLA_PIN");
});

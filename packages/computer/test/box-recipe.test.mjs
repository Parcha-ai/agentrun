// The image a remote computer with an Archil mount starts from (box/Dockerfile, which runs box/install.sh, built by
// box/build-daytona.py, box/build-modal.py and box/build-e2b.mjs, published by release.yml's box job, and registered by
// Agent37's prepareImage), read as text: no network, no docker, no provider. install.sh is the whole build, so a vendor
// that builds its image in its own account runs the same steps. It installs the root helper where the provider
// runs it as root, the tool user computerd runs every tool as, and the archil client pinned by version and sha256. It
// has no sudo and no sudoers file: the provider's own exec is root (the image's user is root), and the tool user has no
// way to root at all.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ARCHIL_HELPER, ARCHIL_SYNC_SOCKET, ARCHIL_TOOL_USER, ARCHIL_TOOL_UID, DAEMON_IN_COMPUTER } from "../dist/index.js";

const box = (name) => new URL(`../box/${name}`, import.meta.url);
const read = (name) => readFileSync(box(name), "utf8");
const DOCKERFILE = read("Dockerfile");
const HELPER = read("agentrun-archil");
/** The build's steps, as POSIX shell, continuation lines joined. */
const INSTALL = read("install.sh").replace(/\\\n\s*/g, " ");
/** The Dockerfile's instructions, a line each, continuation lines joined. */
const INSTRUCTIONS = DOCKERFILE.replace(/\\\n/g, " ").split("\n").filter((line) => line.trim() && !line.startsWith("#"));
/** The body of one of install.sh's steps, the shell function `name() { … }`. */
const step = (name) => {
  const body = INSTALL.match(new RegExp(`^${name}\\(\\) \\{\\n([^]*?)^\\}$`, "m"))?.[1];
  assert.ok(body, `install.sh has the step ${name}()`);
  return body;
};
/** Where the Dockerfile puts install.sh and the helper for the one RUN, which removes them. */
const STAGE = "/tmp/agentrun-box";
/** A fixed value the helper sets at its top (`NAME=value`). */
const fixed = (name) => HELPER.match(new RegExp(`^${name}=(\\S+)$`, "m"))?.[1];
/** The archil client the live checks ran. */
const ARCHIL_VERSION = "0.10.1-1793222256";
/** What an unpinned package sum reads until its sha256 is fetched and pinned. */
const UNPINNED = "unpinned";
/** The image's first process: agentrun-dial when the create set AGENTRUN_ATTACH_URL (a machine that dials the server),
 *  else nothing but a wait, for the provider's own process to run what a computer runs. */
const CMD = 'CMD ["sh", "-c", "[ -z \\"${AGENTRUN_ATTACH_URL-}\\" ] || exec agentrun-dial; exec sleep infinity"]';

test("the Dockerfile's one build step is install.sh, with the helper beside it, run as root on the base; the recipe and every build's name cover it", async () => {
  // install.sh is the build a vendor without a Docker build runs on its own base: one source, so the Dockerfile has no
  // step of its own beyond running it.
  assert.deepEqual(INSTRUCTIONS.slice(1), [
    `COPY install.sh ${STAGE}/install.sh`,
    `COPY agentrun-archil ${STAGE}/agentrun-archil`,
    `RUN sh ${STAGE}/install.sh && rm -rf ${STAGE}`,
    "USER root",
    CMD,
  ]);
  const { RECIPE } = await import("../box/recipe.mjs");
  assert.deepEqual([...RECIPE], ["Dockerfile", "install.sh", "agentrun-archil"], "a change to install.sh is a new image");
  assert.ok(read("build-daytona.py").includes('for name in ("Dockerfile", "install.sh", "agentrun-archil")'), "and a new Daytona snapshot");
});

test("install.sh is POSIX shell that stops at the first failure, runs its steps in the Dockerfile's old order, and is safe to run twice: each step checks what it makes first", () => {
  const script = read("install.sh");
  assert.match(script, /^#!\/bin\/sh\n/);
  assert.match(script, /^set -eu$/m);
  const code = INSTALL.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
  assert.ok(!/\[\[|\bfunction\b|\$\{[A-Za-z_]+\[|<<<|\bsource\b/.test(code), "no bash: no [[, function, arrays, here-strings or source");
  assert.ok(spawnSync("sh", ["-n", fileURLToPath(box("install.sh"))]).status === 0, "sh reads it");
  assert.match(INSTALL, /^case "\$\*" in\n""\) packages; desktop; helper; dial; checked ;;\nchecked\) checked ;;\n/m, "the whole build in order, or the last step alone");
  // A vendor's snapshot flow may retry the build on the same machine: each step that makes something checks first.
  assert.match(step("packages"), /getent group agentrun-tool >\/dev\/null \|\| groupadd /);
  assert.match(step("packages"), /id -u agentrun-tool >\/dev\/null 2>&1 \|\| useradd /);
  assert.match(step("packages"), /if \[ "\$\(dpkg-query -W -f '\$\{Version\}' archil 2>\/dev\/null\)" != "\$ARCHIL_VERSION" \]; then/, "the archil client is fetched only when another version, or none, is installed");
  assert.match(step("checked"), /if dpkg -s sudo >\/dev\/null 2>&1; then /, "sudo is purged only where it is installed");
  // It reads no network beyond what the Dockerfile read: Debian's mirrors through apt, and Archil's package.
  assert.deepEqual([...INSTALL.matchAll(/https?:\/\/[^\s"']+/g)].map((match) => match[0]), ["https://s3.amazonaws.com/archil-client/pkg/archil_${ARCHIL_VERSION}_${arch}.deb"]);
});

test("the image pins the archil client the live checks ran, by version and sha256, and refuses to build, in words, while a sum is unpinned", () => {
  assert.match(INSTRUCTIONS[0], /^FROM python:3\.12-slim@sha256:[0-9a-f]{64}$/);
  assert.match(INSTALL, new RegExp(`^ARCHIL_VERSION=${ARCHIL_VERSION}$`, "m"), "archil 0.10.1");
  for (const arch of ["AMD64", "ARM64"]) assert.match(INSTALL, new RegExp(`^ARCHIL_SHA256_${arch}=(?:[0-9a-f]{64}|${UNPINNED})$`, "m"), arch);
  assert.ok(INSTALL.includes('archil_${ARCHIL_VERSION}_${arch}.deb'), "the package is the pinned version's");
  assert.ok(INSTALL.includes('echo "$sum  /tmp/archil.deb" | sha256sum -c -'), "the package is checked before it is installed");
  assert.ok(
    INSTALL.includes(`case "$sum" in ${UNPINNED}) echo "archil \${ARCHIL_VERSION} for $arch has no pinned sha256 yet: set ARCHIL_SHA256_`),
    "an unpinned sum stops the build, saying which",
  );
});

test("the helper is installed root:root 0755 at the path the provider runs it from", () => {
  assert.equal(ARCHIL_HELPER, "/usr/local/sbin/agentrun-archil");
  assert.match(INSTALL, new RegExp(`^HELPER=${ARCHIL_HELPER}$`, "m"));
  assert.match(step("helper"), /cp "\$here\/agentrun-archil" "\$HELPER"/, "install.sh copies the helper beside it there");
  assert.ok(step("checked").includes('chown root:root "$HELPER"'), "owned by root");
  assert.ok(step("checked").includes('chmod 0755 "$HELPER"'), "mode 0755");
  assert.ok(HELPER.includes(`Install it root:root 0755 at ${ARCHIL_HELPER}`), "the helper's own words name the same path");
});

test("the tool user is agentrun-tool, uid and gid 2510, and the helper's serve names the same user", () => {
  assert.equal(ARCHIL_TOOL_USER, "agentrun-tool");
  assert.equal(ARCHIL_TOOL_UID, 2510);
  assert.equal(fixed("TOOL"), ARCHIL_TOOL_USER);
  assert.ok(INSTALL.includes(`groupadd --gid ${ARCHIL_TOOL_UID} ${ARCHIL_TOOL_USER}\n`));
  assert.ok(INSTALL.includes(`useradd --uid ${ARCHIL_TOOL_UID} --gid ${ARCHIL_TOOL_UID} --no-create-home --home-dir /tmp --shell /bin/sh ${ARCHIL_TOOL_USER}\n`));
  assert.ok(INSTALL.includes(`[ "$ids" = "${ARCHIL_TOOL_UID}:${ARCHIL_TOOL_UID}" ]`), "the build reads the ids back");
});

test("no sudo: the image installs none and has no sudoers file, its user is root, and the build checks that the tool user has no way to root", () => {
  const installed = [...INSTALL.matchAll(/apt-get install -y -qq --no-install-recommends (.*?) >\/dev\/null/g)].map((match) => match[1]);
  assert.ok(installed.length >= 2, "the base's packages and the desktop's");
  assert.ok(!/\bsudo\b/.test(installed.join(" ")), "no sudo package");
  assert.ok(!INSTRUCTIONS.some((line) => line.startsWith("COPY") && line.includes("sudoers")), "no sudoers file is copied");
  assert.ok(!/\bdaytona\b/.test(INSTRUCTIONS.join("\n") + INSTALL), "no daytona user, and nothing granted to one");
  const users = INSTRUCTIONS.filter((line) => line.startsWith("USER "));
  assert.deepEqual(users, ["USER root"], "the provider's own exec is root");
  const checked = step("checked");
  assert.ok(checked.includes("! command -v sudo >/dev/null 2>&1 || { echo \"the image has sudo\" >&2; exit 1; }\n"), "the build fails if a base brings sudo");
  assert.ok(checked.includes("[ ! -e /etc/sudoers ] && [ ! -e /etc/sudoers.d ] || { echo \"the image has a sudoers file\" >&2; exit 1; }\n"), "and if a base brings sudoers");
  assert.ok(!HELPER.includes("NOPASSWD") && !HELPER.includes("sudoers"), "the helper's words grant nothing through sudo");
  // The E2B live run: E2B's template builder adds sudo to the base before the recipe's steps, and the guard refused the
  // build. The recipe takes away any sudo a base brought (the package where apt has it, and every sudoers file), then
  // the guard checks that none is left, for any provider's base.
  const purge = checked.indexOf("apt-get purge -y -qq sudo");
  const sudoers = checked.indexOf("rm -rf /etc/sudoers /etc/sudoers.d");
  const guard = checked.indexOf("! command -v sudo >/dev/null 2>&1");
  assert.ok(purge > 0 && sudoers > 0 && purge < guard && sudoers < guard, "sudo and sudoers are taken away before the guard checks there are none");
  assert.equal(INSTRUCTIONS.at(-1), CMD);
});

test("the image has every program the helper runs, at the helper's paths, and an empty /workspace; the sync socket's folder is serve's own", () => {
  for (const name of ["ARCHIL", "MOUNT", "CHOWN"]) {
    const path = fixed(name);
    assert.ok(path, `the helper fixes ${name}`);
    assert.match(step("checked"), new RegExp(`for x in [^;]*${path.replace(/\//g, "\\/")}[ ;]`), `the build checks ${path}`);
  }
  assert.match(step("packages"), /apt-get install [^;]* fuse3[ ;>]/);
  // No firewall: the tools' network is init's own namespace (computerd init --own-network), not the image's rules.
  assert.ok(!/iptables|ip6tables/.test(INSTALL), "the image installs and checks no iptables");
  assert.equal(fixed("MP"), "/workspace");
  assert.ok(step("packages").includes("install -d -o root -g root -m 0755 /workspace"));
  assert.equal(fixed("COMPUTERD"), DAEMON_IN_COMPUTER, "serve runs the daemon the provider installs");
  assert.equal(fixed("SOCK"), ARCHIL_SYNC_SOCKET);
  assert.ok(!INSTALL.includes(ARCHIL_SYNC_SOCKET.slice(0, ARCHIL_SYNC_SOCKET.lastIndexOf("/"))), "the image makes no sync folder: serve makes it, root's");
});

test("each build names what it made, and the Daytona snapshot's name covers every file the image copies", () => {
  const daytona = read("build-daytona.py");
  const modal = read("build-modal.py");
  assert.ok(daytona.includes('print(f"snapshot={name}")'));
  assert.ok(modal.includes('print(f"image={image.object_id}")'));
  const copied = INSTRUCTIONS.filter((line) => line.startsWith("COPY ")).map((line) => line.split(/\s+/)[1]);
  assert.deepEqual(copied, ["install.sh", "agentrun-archil"]);
  const hashed = daytona.match(/for name in \(([^)]*)\)/)?.[1].split(",").map((name) => name.trim().replace(/^"|"$/g, "")).filter(Boolean);
  assert.deepEqual(hashed?.sort(), ["Dockerfile", ...copied].sort());
  // Daytona runs a snapshot's entrypoint, never the image's CMD: the snapshot names the CMD, under a name no snapshot
  // built without it holds (agentrun-archil-<hash> was).
  assert.ok(daytona.includes("entrypoint=cmd,") && daytona.includes('line.startswith("CMD ")'), "the Dockerfile's CMD is the snapshot's entrypoint");
  assert.ok(daytona.includes('else f"agentrun-box-{digest}"'), "named agentrun-box-<the recipe's hash>");
});

test("the E2B build makes a template from the same Dockerfile, with the workspace's own e2b SDK, and names it by the recipe's hash, every copied file in it", () => {
  // The E2B live stage had no template to run: box/ built a Daytona snapshot and a Modal image only.
  const e2b = read("build-e2b.mjs");
  // The host's own e2b SDK, as src/e2b.ts takes it: a dynamic import of a name that is not a literal, so the package
  // declares no dependency on it, and words that say how to get it when it is missing.
  assert.ok(e2b.includes('const E2B_PACKAGE = "e2b";') && e2b.includes("await import(E2B_PACKAGE)"), "the host's e2b SDK, imported by name");
  assert.doesNotMatch(e2b, /from "e2b"/, "no static import the package would have to declare");
  assert.match(e2b, /npm ci/, "says how to install it when it is missing");
  assert.match(e2b, /fromDockerfile\(/);
  assert.match(e2b, /Template\.build\(/);
  assert.ok(e2b.includes("console.log(`template=${name}`)"), "it prints the template's name, as the other builds print theirs");
  assert.ok(e2b.includes('const name = "agentrun-archil-" + hash;') && e2b.includes("const hash = recipeHash(here);"), "named agentrun-archil-<the recipe's hash>");
  assert.ok(!/process\.env\.\w*KEY/.test(e2b.replace(/process\.env\.E2B_API_KEY/g, "")), "the key comes from E2B_API_KEY, the SDK's own, set by the caller for this one command");
});

/** How release.yml's box job reads the recipe's hash, at the repository's root. */
const RELEASE_RECIPE = "import { recipeHash } from './packages/computer/box/recipe.mjs'; console.log(recipeHash())";

test("the recipe is the Dockerfile and every file it copies, and its hash is the one the Daytona snapshot is named by", async () => {
  const { RECIPE, recipeHash } = await import("../box/recipe.mjs");
  const copied = INSTRUCTIONS.filter((line) => line.startsWith("COPY ")).map((line) => line.split(/\s+/)[1]);
  assert.deepEqual([...RECIPE].sort(), ["Dockerfile", ...copied].sort());
  // build-daytona.py hashes the same files the same way: sha256 of their bytes in RECIPE's order, its first 12 hex.
  const daytona = read("build-daytona.py");
  assert.ok(daytona.includes(`for name in (${RECIPE.map((name) => `"${name}"`).join(", ")})`), "the Daytona build hashes RECIPE, in its order");
  assert.ok(daytona.includes("hashlib.sha256(recipe).hexdigest()[:12]"));
  const hash = recipeHash();
  assert.equal(hash, createHash("sha256").update(Buffer.concat(RECIPE.map((name) => readFileSync(box(name))))).digest("hex").slice(0, 12));
  // What release.yml's box job runs, at the repository's root: the hash alone.
  const printed = execFileSync(process.execPath, ["--input-type=module", "-e", RELEASE_RECIPE], { encoding: "utf8", cwd: fileURLToPath(new URL("../../../", import.meta.url)) });
  assert.equal(printed, `${hash}\n`);
});

test("on the published image, the E2B template runs install.sh's last step again, as root (sudo taken away, every check), and keeps the Dockerfile's USER and CMD; a tag that is not the recipe's is refused", async () => {
  const { onImage, recipeHash } = await import("../box/recipe.mjs");
  const image = `ghcr.io/parcha-ai/agentrun-box:${recipeHash()}`;
  const dockerfile = onImage(image);
  const lines = dockerfile.replace(/\\\n/g, " ").split("\n").filter(Boolean);
  assert.deepEqual(
    lines,
    [`FROM ${image}`, `COPY install.sh ${STAGE}/install.sh`, `RUN sh ${STAGE}/install.sh checked && rm -rf ${STAGE}`, "USER root", CMD],
    "install.sh's checked step, then root, then the same first process",
  );
  assert.ok(step("checked").includes("rm -rf /etc/sudoers /etc/sudoers.d") && step("checked").includes("! command -v sudo"), "the step takes sudo away and checks it gone");
  // Refused before the SDK or the key is read, so this runs with neither.
  const script = fileURLToPath(box("build-e2b.mjs"));
  const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { PATH: process.env.PATH } });
  const other = run(["--image", "ghcr.io/parcha-ai/agentrun-box:000000000000"]);
  assert.equal(other.status, 2);
  assert.match(other.stderr, new RegExp(`is not this recipe's image: its tag must be the recipe's hash, ${recipeHash()}`));
  const keyless = run(["--image", image, "--public"]);
  assert.equal(keyless.status, 2);
  assert.match(keyless.stderr, /set E2B_API_KEY/);
});

/** A fake e2b package: records the template, the build and the PATCH in FAKE_E2B_LOG; FAKE_E2B_PATCH=fail refuses the PATCH. */
const FAKE_E2B = `import { appendFileSync } from "node:fs";
const log = (entry) => appendFileSync(process.env.FAKE_E2B_LOG, JSON.stringify(entry) + "\\n");
export function Template(options) {
  return { fromDockerfile(dockerfile) { log({ template: options, dockerfile }); return this; } };
}
Template.build = async (template, name, options) => { log({ build: name, cpuCount: options.cpuCount, memoryMB: options.memoryMB }); return { templateId: "tpl_0123", buildId: "b_1", name }; };
export class ConnectionConfig { constructor(options) { this.apiKey = options.apiKey; } }
export class ApiClient {
  constructor(config) {
    this.api = { PATCH: async (path, init) => {
      log({ patch: path, init, apiKey: config.apiKey });
      if (process.env.FAKE_E2B_PATCH === "fail") return { error: { message: "template not found" }, response: { status: 404 } };
      return { data: { names: ["parcha/" + "agentrun-archil-x", "agentrun-archil-x"] }, response: { status: 200 } };
    } };
  }
}
`;

test("build-e2b.mjs --image --public builds from the image, makes the template public by its id, prints the names E2B gives, and fails in E2B's words when the PATCH is refused", async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { recipeHash, onImage } = await import("../box/recipe.mjs");
  // A copy of box/ beside a fake e2b package, which the script finds by its name, as it finds the root's.
  const dir = mkdtempSync(join(tmpdir(), "box-e2b-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ["Dockerfile", "install.sh", "agentrun-archil", "build-e2b.mjs", "recipe.mjs"]) copyFileSync(box(name), join(dir, name));
  mkdirSync(join(dir, "node_modules", "e2b"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "e2b", "package.json"), JSON.stringify({ name: "e2b", type: "module", exports: "./index.js" }));
  writeFileSync(join(dir, "node_modules", "e2b", "index.js"), FAKE_E2B);
  const image = `ghcr.io/parcha-ai/agentrun-box:${recipeHash()}`;
  const run = (log, env = {}) => spawnSync(process.execPath, [join(dir, "build-e2b.mjs"), "--image", image, "--public"], { encoding: "utf8", env: { PATH: process.env.PATH, E2B_API_KEY: "fake-test-key", FAKE_E2B_LOG: join(dir, log), ...env } });
  const entries = (log) => readFileSync(join(dir, log), "utf8").trim().split("\n").map((line) => JSON.parse(line));

  const ok = run("ok.log");
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, `public=parcha/agentrun-archil-x,agentrun-archil-x\ntemplate=agentrun-archil-${recipeHash()}\n`);
  const [template, build, patch] = entries("ok.log");
  assert.equal(template.dockerfile, onImage(image), "the template is the image with install.sh's last step, and the Dockerfile's USER and CMD");
  assert.deepEqual(build, { build: `agentrun-archil-${recipeHash()}`, cpuCount: 2, memoryMB: 4096 });
  assert.deepEqual(patch, { patch: "/v2/templates/{templateID}", init: { params: { path: { templateID: "tpl_0123" } }, body: { public: true } }, apiKey: "fake-test-key" });
  assert.ok(!ok.stderr.includes("fake-test-key") && !ok.stdout.includes("fake-test-key"), "the key is never printed");

  const refused = run("refused.log", { FAKE_E2B_PATCH: "fail" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, new RegExp(`making agentrun-archil-${recipeHash()} public failed: 404 template not found`));
  assert.doesNotMatch(refused.stdout, /public=|template=/, "a template that is not public is not reported as made");
});

test("the box job builds only on the registry's not found: a published recipe is tagged, and any other failed read stops the job", async (t) => {
  const { mkdtempSync, writeFileSync, rmSync, chmodSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { parse } = await import("yaml");
  const workflow = parse(readFileSync(new URL("../../../.github/workflows/release.yml", import.meta.url), "utf8"));
  const step = workflow.jobs.box.steps.find((step) => step.id === "published");
  const dir = mkdtempSync(join(tmpdir(), "box-published-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A fake docker whose imagetools inspect prints what FAKE_DOCKER says, as buildx does, and exits with its code.
  writeFileSync(join(dir, "docker"), '#!/bin/sh\nprintf "%s\\n" "$FAKE_DOCKER_OUT" >&2\nexit "$FAKE_DOCKER_EXIT"\n');
  chmodSync(join(dir, "docker"), 0o755);
  const run = (exit, out) => {
    const output = join(dir, `output-${exit}-${out.length}`);
    writeFileSync(output, "");
    const result = spawnSync("bash", ["-e", "-c", step.run], { encoding: "utf8", env: { PATH: `${dir}:${process.env.PATH}`, GITHUB_OUTPUT: output, IMAGE: "ghcr.io/parcha-ai/agentrun-box", RECIPE: "0123456789ab", RELEASE_TAG: "v0.1.0-beta.1", FAKE_DOCKER_EXIT: String(exit), FAKE_DOCKER_OUT: out } });
    return { ...result, output: readFileSync(output, "utf8") };
  };
  const published = run(0, "");
  assert.equal(published.status, 0);
  assert.equal(published.output, "published=true\n");
  const absent = run(1, "ERROR: ghcr.io/parcha-ai/agentrun-box:0123456789ab: not found");
  assert.equal(absent.status, 0);
  assert.equal(absent.output, "published=false\n");
  const flaky = run(1, "ERROR: failed to do request: Head \"https://ghcr.io/v2/parcha-ai/agentrun-box/manifests/0123456789ab\": dial tcp: i/o timeout");
  assert.equal(flaky.status, 1, "a read that fails otherwise stops the job: no rebuild under a tag that may exist");
  assert.equal(flaky.output, "");
  assert.match(flaky.stderr, /::error::reading ghcr\.io\/parcha-ai\/agentrun-box:0123456789ab failed, so whether it is published is unknown: ERROR: failed to do request/);
});

// --- what a build of box/ can take in: no key, credential or build secret ---

/** Every file under box/, by its path there. */
const BOX_FILES = readdirSync(fileURLToPath(box("")), { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => relative(fileURLToPath(box("")), join(entry.parentPath, entry.name)));
/** Names a key or a credential goes by. */
const CREDENTIAL_NAME = /(^|\/)(\.env(\..*)?|\.npmrc|\.netrc|\.pypirc|\.git-credentials|\.dockercfg|config\.json|credentials(\..*)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx|jks|keystore|crt|asc|gpg|kdbx)|.*(secret|token|passw|apikey|api_key|private).*)$/i;
/** Key material in a file's text: a private key block, or a token in a vendor's own shape. */
const KEY_MATERIAL = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bsk-(ant-|proj-)?[A-Za-z0-9_-]{20,}/,
  /\bsk_live_[A-Za-z0-9]{16,}/,
  /\be2b_[0-9a-f]{20,}/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
];

test("a build's context is box/, the files the npm package ships there, and the image takes install.sh and the helper alone from it", () => {
  const copied = INSTRUCTIONS.filter((line) => /^(COPY|ADD) /.test(line)).map((line) => line.split(/\s+/).slice(1, -1));
  assert.deepEqual(copied, [["install.sh"], ["agentrun-archil"]], "a COPY of the build and one of the helper, with no flags (no --from, no remote ADD)");
  // No .dockerignore: everything here is public already (the package ships box/ whole), and the image copies install.sh
  // and the helper alone. A new file here is read for what it is before this list takes it.
  assert.deepEqual(BOX_FILES.sort(), ["Dockerfile", "README.md", "agentrun-archil", "build-daytona.py", "build-e2b.mjs", "build-modal.py", "install.sh", "recipe.d.mts", "recipe.mjs"]);
});

test("box/ holds no file named like a key or a credential and no key material, and the Dockerfile takes no secret", () => {
  for (const file of BOX_FILES) {
    assert.doesNotMatch(file, CREDENTIAL_NAME, `${file} is named like a key or a credential`);
    const text = readFileSync(box(file), "utf8");
    for (const pattern of KEY_MATERIAL) assert.doesNotMatch(text, pattern, `${file} holds key material`);
  }
  assert.doesNotMatch(DOCKERFILE, /--mount=[^\s]*type=(secret|ssh)/, "no build secret and no ssh agent");
  for (const line of INSTRUCTIONS.filter((line) => /^(ARG|ENV) /.test(line))) {
    assert.doesNotMatch(line.split(/\s+/)[1].split("=")[0], /KEY|TOKEN|SECRET|PASS|CRED|AUTH|PRIVATE/i, `${line}: a build argument or variable named like a secret`);
  }
  assert.deepEqual(INSTRUCTIONS.filter((line) => /^(ARG|ENV) /.test(line)), [], "the pins are install.sh's, so a vendor's build has them too");
  // agentrun-dial, which the build only writes, reads the machine's token at boot (test/agentrun-dial.test.mjs).
  const build = INSTALL.replace(/<<'EOF'\n[^]*?\nEOF\n/, "");
  assert.ok(build.length < INSTALL.length && build.includes("dial() {"), "the build without agentrun-dial's text");
  assert.doesNotMatch(build, /\$\{?[A-Z_]*(KEY|TOKEN|SECRET|PASS|CRED|AUTH|PRIVATE)/, "install.sh reads no variable named like a secret");
  // The patterns catch what they are for.
  assert.match("id_ed25519", CREDENTIAL_NAME);
  assert.match("deploy.pem", CREDENTIAL_NAME);
  assert.match("e2b-token.txt", CREDENTIAL_NAME);
  assert.ok(KEY_MATERIAL.some((pattern) => pattern.test(["-----BEGIN OPENSSH", "PRIVATE KEY-----"].join(" "))));
});

// --- the release's box job, which also builds its E2B template (.github/workflows/release.yml) ---

test("the release publishes the box image beside agentrun-server, amd64, by the recipe's hash, and builds the public E2B template from it in the same job, under the release's approval", async () => {
  const { parse } = await import("yaml");
  const workflow = parse(readFileSync(new URL("../../../.github/workflows/release.yml", import.meta.url), "utf8"));
  const { box: job, image, publish } = workflow.jobs;
  assert.equal(workflow.jobs["box-e2b"], undefined, "one job: a second job under the approval would ask for it again");
  assert.equal(job.needs, "gate", "after the gate alone, so it asks for the npm-release approval with the publish job");
  assert.equal(job.if, publish.if);
  assert.equal(job.environment, "npm-release", "under the release's own approval, whose E2B_API_KEY it reads");
  assert.deepEqual(job.permissions, image.permissions, "the image job's: read, and write packages");
  for (const step of job.steps.filter((step) => step.uses)) assert.match(step.uses, /@[0-9a-f]{40}$/, `${step.uses} is pinned by commit`);
  const buildx = job.steps.find((step) => /^docker\/setup-buildx-action@/.test(step.uses ?? ""));
  assert.deepEqual(buildx, image.steps.find((step) => /^docker\/setup-buildx-action@/.test(step.uses ?? "")), "BuildKit by digest, as the image job runs it");
  assert.match(buildx.with["driver-opts"], /@sha256:[0-9a-f]{64}$/);
  const recipe = job.steps.find((step) => step.id === "recipe");
  assert.ok(recipe.run.includes(`hash="$(node --input-type=module -e "${RELEASE_RECIPE}")"`), "the hash recipe.mjs gives, not one of the workflow's own");
  assert.equal(job.outputs.recipe, "${{ steps.recipe.outputs.hash }}");
  const build = job.steps.find((step) => /^docker\/build-push-action@/.test(step.uses ?? ""));
  assert.equal(build.uses, image.steps.find((step) => /^docker\/build-push-action@/.test(step.uses ?? "")).uses);
  assert.equal(build.with.context, "packages/computer/box");
  assert.equal(build.with.file, "packages/computer/box/Dockerfile");
  assert.equal(build.with.platforms, "linux/amd64");
  assert.equal(build.with.provenance, "mode=max");
  assert.equal(build.with.sbom, true);
  assert.equal(build.with.push, true);
  assert.equal(build.with["build-args"], undefined);
  assert.equal(build.with.secrets, undefined);
  assert.deepEqual(build.with.tags.trim().split("\n"), ["${{ env.IMAGE }}:${{ steps.recipe.outputs.hash }}", "${{ env.IMAGE }}:${{ inputs.tag }}"]);
  assert.equal(job.env.IMAGE, "ghcr.io/parcha-ai/agentrun-box");
  assert.equal(build.if, "steps.published.outputs.published != 'true'", "built once per recipe");
  assert.match(job.steps.find((step) => step.if === "steps.published.outputs.published == 'true'").run, /imagetools create --tag "\$IMAGE:\$RELEASE_TAG" "\$IMAGE:\$RECIPE"/, "a published recipe is tagged with the release");

  // The E2B template, from the image the steps above published.
  const secrets = JSON.stringify(job).match(/secrets\.\w+/g).filter((name) => name !== "secrets.GITHUB_TOKEN");
  assert.deepEqual([...new Set(secrets)], ["secrets.E2B_API_KEY"], "beside this run's GITHUB_TOKEN, which pushes the box image, the E2B key is the one secret it reads");
  const at = (pattern) => job.steps.findIndex((step) => pattern.test(step.run ?? step.uses ?? ""));
  const key = at(/\[ -n "\$E2B_API_KEY" \] \|\| \{ echo "::error::needs secret E2B_API_KEY in the npm-release environment/);
  assert.ok(key > at(/^docker\/build-push-action@/) && key > at(/imagetools create --tag/), "a missing key stops the template, in words, after the box image is published");
  assert.ok(key < at(/ghcr-published\.mjs/) && at(/ghcr-published\.mjs/) < at(/build-e2b\.mjs/), "then the image is checked public before E2B is asked to pull it");
  const template = job.steps[at(/build-e2b\.mjs/)];
  assert.equal(template.run, 'node packages/computer/box/build-e2b.mjs --image "$BOX_IMAGE" --public');
  for (const step of [job.steps[at(/ghcr-published\.mjs/)], template]) assert.equal(step.env.BOX_IMAGE, "${{ env.IMAGE }}:${{ steps.recipe.outputs.hash }}", "the image this job published, by its recipe's tag");
  assert.match(job.steps[at(/ghcr-published\.mjs/)].run, /^node scripts\/ghcr-published\.mjs "\$BOX_IMAGE" \|\| \{ echo "::error::[^\n]*; exit 1; \}$/m, "anything but an anonymous pull's 200 stops the job");
  assert.equal(template.env.E2B_API_KEY, "${{ secrets.E2B_API_KEY }}");
});

test("the image carries a desktop, nothing started: Xvfb, xfwm4 and the apps, each checked, with no sudo", async () => {
  // The script computerd's window-manager start becomes (daemon/internal/windowmanager).
  const script = readFileSync(new URL("../daemon/internal/windowmanager/windowmanager.go", import.meta.url), "utf8").match(/^const script = `([^`]*)`$/m)?.[1] ?? "";
  const { DESKTOP_APPS } = await import("../dist/conformance/cases/apps.js");
  const desktop = step("desktop");
  const packages = desktop.match(/apt-get install -y -qq --no-install-recommends (.*?) >\/dev\/null\n/)?.[1].trim().split(/\s+/) ?? [];
  for (const name of ["xvfb", "xfwm4", "x11-xserver-utils", "xfce4-terminal", "mousepad", "firefox-esr", "xdotool"]) assert.ok(packages.includes(name), name);
  assert.ok(!packages.some((name) => /vnc|sudo/.test(name)), "no VNC server and no sudo");
  assert.ok(!INSTRUCTIONS.some((line) => /^(CMD|ENTRYPOINT) /.test(line) && /Xvfb|xfwm4/.test(line)), "nothing of the desktop starts with the image");
  assert.ok(INSTALL.indexOf("desktop() {") < INSTALL.indexOf("checked() {") && /packages; desktop; helper; dial; checked/.test(INSTALL), "the sudo guard runs after the desktop's packages");
  const programs = desktop.match(/for x in ([^;]*); do command -v "\$x"/)?.[1].split(" ") ?? [];
  assert.ok(programs.includes("Xvfb"), "the build checks the X server is there");
  // The window manager's programs beyond Debian's essential ones (sh). xsetroot paints the desktop's background before
  // xfwm4 starts, so a desktop with no window open is not a black screen.
  for (const program of ["dbus-run-session", "xfwm4", "xsetroot"]) {
    assert.ok(script.includes(`${program} `), `the window manager runs ${program}`);
    assert.ok(programs.includes(program), `the build checks the window manager's ${program} is there`);
  }
  const apps = desktop.match(/for app in ([^;]*); do/)?.[1].split(" ") ?? [];
  assert.ok(apps.some((app) => DESKTOP_APPS.includes(app)), "the build checks a desktop file the conformance apps case opens");
  // E2B's builder adds sudo before the recipe's steps: a sudo check here would refuse its build before the guard takes it away.
  assert.doesNotMatch(desktop, /command -v sudo/, "the desktop's no-sudo check is the guard's, after it");
});

test("the default box recipe's hash is d289bcc6d0c2: a recipe change is a box bump, a new image and snapshot of that name", async () => {
  // Another image (media/, documents/) is a recipe of its own; nothing it adds moves this one. A change here names a new
  // ghcr.io/parcha-ai/agentrun-box:<hash> (the release's box job publishes it), a new Daytona snapshot
  // agentrun-box-<hash> (box/build-daytona.py) for AGENTRUN_DAYTONA_SNAPSHOT, and relays/cloudflare/wrangler.json's image.
  const { recipeHash } = await import("../box/recipe.mjs");
  assert.equal(recipeHash(), "d289bcc6d0c2");
});

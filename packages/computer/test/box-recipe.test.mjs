// The image a remote computer with an Archil mount starts from (box/Dockerfile, built by box/build-daytona.py and
// box/build-modal.py), read as text: no network, no docker, no provider. It installs the root helper where the provider
// runs it as root, the tool user computerd runs every tool as, and the archil client pinned by version and sha256. It
// has no sudo and no sudoers file: the provider's own exec is root (the image's user is root), and the tool user has no
// way to root at all.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ARCHIL_HELPER, ARCHIL_SYNC_SOCKET, ARCHIL_TOOL_USER, ARCHIL_TOOL_UID, DAEMON_IN_COMPUTER } from "../dist/index.js";

const box = (name) => new URL(`../box/${name}`, import.meta.url);
const read = (name) => readFileSync(box(name), "utf8");
const DOCKERFILE = read("Dockerfile");
const HELPER = read("agentrun-archil");
/** The Dockerfile's instructions, a line each, continuation lines joined. */
const INSTRUCTIONS = DOCKERFILE.replace(/\\\n/g, " ").split("\n").filter((line) => line.trim() && !line.startsWith("#"));
/** A fixed value the helper sets at its top (`NAME=value`). */
const fixed = (name) => HELPER.match(new RegExp(`^${name}=(\\S+)$`, "m"))?.[1];
/** The archil client the live checks ran. */
const ARCHIL_VERSION = "0.10.1-1793222256";
/** What an unpinned package sum reads until its sha256 is fetched and pinned. */
const UNPINNED = "unpinned";

test("the image pins the archil client the live checks ran, by version and sha256, and refuses to build, in words, while a sum is unpinned", () => {
  assert.match(INSTRUCTIONS[0], /^FROM python:3\.12-slim@sha256:[0-9a-f]{64}$/);
  assert.ok(INSTRUCTIONS.includes(`ARG ARCHIL_VERSION=${ARCHIL_VERSION}`), "archil 0.10.1");
  for (const arch of ["AMD64", "ARM64"]) assert.match(DOCKERFILE, new RegExp(`^ARG ARCHIL_SHA256_${arch}=(?:[0-9a-f]{64}|${UNPINNED})$`, "m"), arch);
  assert.ok(DOCKERFILE.includes('archil_${ARCHIL_VERSION}_${arch}.deb'), "the package is the pinned version's");
  assert.ok(DOCKERFILE.includes('echo "$sum  /tmp/archil.deb" | sha256sum -c -'), "the package is checked before it is installed");
  assert.ok(
    DOCKERFILE.includes(`case "$sum" in ${UNPINNED}) echo "archil \${ARCHIL_VERSION} for $arch has no pinned sha256 yet: set ARCHIL_SHA256_`),
    "an unpinned sum stops the build, saying which",
  );
});

test("the helper is installed root:root 0755 at the path the provider runs it from", () => {
  assert.equal(ARCHIL_HELPER, "/usr/local/sbin/agentrun-archil");
  assert.ok(INSTRUCTIONS.includes(`COPY agentrun-archil ${ARCHIL_HELPER}`), "the Dockerfile copies the helper there");
  assert.ok(DOCKERFILE.includes(`chown root:root ${ARCHIL_HELPER};`), "owned by root");
  assert.ok(DOCKERFILE.includes(`chmod 0755 ${ARCHIL_HELPER};`), "mode 0755");
  assert.ok(HELPER.includes(`Install it root:root 0755 at ${ARCHIL_HELPER}`), "the helper's own words name the same path");
});

test("the tool user is agentrun-tool, uid and gid 2510, and the helper's serve names the same user", () => {
  assert.equal(ARCHIL_TOOL_USER, "agentrun-tool");
  assert.equal(ARCHIL_TOOL_UID, 2510);
  assert.equal(fixed("TOOL"), ARCHIL_TOOL_USER);
  assert.ok(DOCKERFILE.includes(`groupadd --gid ${ARCHIL_TOOL_UID} ${ARCHIL_TOOL_USER};`));
  assert.ok(DOCKERFILE.includes(`useradd --uid ${ARCHIL_TOOL_UID} --gid ${ARCHIL_TOOL_UID} --no-create-home --home-dir /tmp --shell /bin/sh ${ARCHIL_TOOL_USER};`));
  assert.ok(DOCKERFILE.includes(`[ "$ids" = "${ARCHIL_TOOL_UID}:${ARCHIL_TOOL_UID}" ]`), "the build reads the ids back");
});

test("no sudo: the image installs none and has no sudoers file, its user is root, and the build checks that the tool user has no way to root", () => {
  assert.ok(!/\bsudo\b/.test(INSTRUCTIONS.filter((line) => line.startsWith("RUN") && line.includes("apt-get install")).join(" ")), "no sudo package");
  assert.ok(!INSTRUCTIONS.some((line) => line.startsWith("COPY") && line.includes("sudoers")), "no sudoers file is copied");
  assert.ok(!/\bdaytona\b/.test(INSTRUCTIONS.join("\n")), "no daytona user, and nothing granted to one");
  const users = INSTRUCTIONS.filter((line) => line.startsWith("USER "));
  assert.deepEqual(users, ["USER root"], "the provider's own exec is root");
  assert.ok(DOCKERFILE.includes("! command -v sudo >/dev/null 2>&1 || { echo \"the image has sudo\" >&2; exit 1; };"), "the build fails if a base brings sudo");
  assert.ok(DOCKERFILE.includes("[ ! -e /etc/sudoers ] && [ ! -e /etc/sudoers.d ] || { echo \"the image has a sudoers file\" >&2; exit 1; };"), "and if a base brings sudoers");
  assert.ok(!HELPER.includes("NOPASSWD") && !HELPER.includes("sudoers"), "the helper's words grant nothing through sudo");
  assert.equal(INSTRUCTIONS.at(-1), 'CMD ["sleep", "infinity"]');
});

test("the image has every program the helper runs, at the helper's paths, and an empty /workspace; the sync socket's folder is serve's own", () => {
  for (const name of ["ARCHIL", "MOUNT", "CHOWN"]) {
    const path = fixed(name);
    assert.ok(path, `the helper fixes ${name}`);
    assert.match(DOCKERFILE, new RegExp(`for x in [^;]*${path.replace(/\//g, "\\/")}[ ;]`), `the build checks ${path}`);
  }
  assert.match(DOCKERFILE, /apt-get install [^;]* fuse3[ ;>]/);
  // No firewall: the tools' network is init's own namespace (computerd init --own-network), not the image's rules.
  assert.ok(!/iptables|ip6tables/.test(INSTRUCTIONS.join("\n")), "the image installs and checks no iptables");
  assert.equal(fixed("MP"), "/workspace");
  assert.ok(DOCKERFILE.includes("install -d -o root -g root -m 0755 /workspace"));
  assert.equal(fixed("COMPUTERD"), DAEMON_IN_COMPUTER, "serve runs the daemon the provider installs");
  assert.equal(fixed("SOCK"), ARCHIL_SYNC_SOCKET);
  assert.ok(!DOCKERFILE.includes(ARCHIL_SYNC_SOCKET.slice(0, ARCHIL_SYNC_SOCKET.lastIndexOf("/"))), "the image makes no sync folder: serve makes it, root's");
});

test("each build names what it made, and the Daytona snapshot's name covers every file the image copies", () => {
  const daytona = read("build-daytona.py");
  const modal = read("build-modal.py");
  assert.ok(daytona.includes('print(f"snapshot={name}")'));
  assert.ok(modal.includes('print(f"image={image.object_id}")'));
  const copied = INSTRUCTIONS.filter((line) => line.startsWith("COPY ")).map((line) => line.split(/\s+/)[1]);
  assert.deepEqual(copied, ["agentrun-archil"]);
  const hashed = daytona.match(/for name in \(([^)]*)\)/)?.[1].split(",").map((name) => name.trim().replace(/^"|"$/g, "")).filter(Boolean);
  assert.deepEqual(hashed?.sort(), ["Dockerfile", ...copied].sort());
});

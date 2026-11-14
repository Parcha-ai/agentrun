// The image a remote computer with an Archil mount starts from (box/Dockerfile, built by box/build-daytona.py and
// box/build-modal.py), read as text: no network, no docker, no provider. It installs the root helper where the provider
// runs it as root, the tool user computerd runs every tool as, and the archil client pinned by version and sha256. It
// has no sudo and no sudoers file: the provider's own exec is root (the image's user is root), and the tool user has no
// way to root at all.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
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
  // The E2B live run: E2B's template builder adds sudo to the base before the recipe's steps, and the guard refused the
  // build. The recipe takes away any sudo a base brought (the package where apt has it, and every sudoers file), then
  // the guard checks that none is left, for any provider's base.
  const purge = DOCKERFILE.indexOf("apt-get purge -y -qq sudo");
  const sudoers = DOCKERFILE.indexOf("rm -rf /etc/sudoers /etc/sudoers.d");
  const guard = DOCKERFILE.indexOf("! command -v sudo >/dev/null 2>&1");
  assert.ok(purge > 0 && sudoers > 0 && purge < guard && sudoers < guard, "sudo and sudoers are taken away before the guard checks there are none");
  assert.ok(DOCKERFILE.includes("dpkg -s sudo >/dev/null 2>&1"), "the package is purged only where it is installed");
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
  assert.ok(e2b.includes('"agentrun-archil-"'), "named agentrun-archil-<hash>, as the Daytona snapshot is");
  const copied = INSTRUCTIONS.filter((line) => line.startsWith("COPY ")).map((line) => line.split(/\s+/)[1]);
  const hashed = e2b.match(/const RECIPE = \[([^\]]*)\]/)?.[1].split(",").map((name) => name.trim().replace(/^"|"$/g, "")).filter(Boolean);
  assert.deepEqual(hashed?.sort(), ["Dockerfile", ...copied].sort());
  assert.ok(!/process\.env\.\w*KEY/.test(e2b) || e2b.includes("E2B_API_KEY"), "the key comes from E2B_API_KEY, the SDK's own, set by the caller for this one command");
});

// --- the Agent37 build (build-agent37.mjs), on a fake Agent37 ---

const agent37Build = await import("../box/build-agent37.mjs");
const AGENT37_KEY = "sk_live_fake_build_key_0123456789";
const UPLOAD = "https://uploads.agent37.test/context?signed=1";

/** The files of a gzipped ustar archive, by name: mode and body. */
function untar(gz) {
  const tar = gunzipSync(gz);
  const files = {};
  for (let at = 0; at + 512 <= tar.length; ) {
    const block = tar.subarray(at, at + 512);
    if (block.every((byte) => byte === 0)) break;
    const field = (from, length) => block.subarray(from, from + length).toString("utf8").replace(/\0.*$/s, "").trim();
    const size = Number.parseInt(field(124, 12), 8);
    files[field(0, 100)] = { mode: Number.parseInt(field(100, 8), 8), body: tar.subarray(at + 512, at + 512 + size).toString("utf8") };
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** Agent37's template and build API as a fetch: the template's description (none: 404), and a build that succeeds after two log reads. */
function fakeBuilds({ description, fail } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const { pathname, search } = new URL(url);
    calls.push({ method, url, path: pathname + search, auth: init.headers?.Authorization, body: init.body });
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url === UPLOAD) return new Response(null, { status: 200 });
    if (init.headers?.Authorization !== `Bearer ${AGENT37_KEY}`) return json(401, { error: { code: "invalid_api_key", message: "Invalid API key" } });
    if (pathname === "/v1/templates/agentrun-box") return description === undefined ? json(404, { error: { code: "not_found", message: "No such template" } }) : json(200, { name: "agentrun-box", revision: 3, description, image_digest: "sha256:old" });
    if (pathname === "/v1/template-builds" && method === "POST") return json(201, { id: "tb_0123456789abcdef0123", status: "created", upload_url: UPLOAD });
    if (pathname.endsWith("/start")) return json(200, { id: "tb_0123456789abcdef0123", status: "building" });
    if (pathname.endsWith("/logs")) {
      const reads = calls.filter((call) => call.path.includes("/logs")).length;
      if (fail) return json(200, { status: "failed", error: { code: "build_failed", message: "step 3 exited 100" }, data: "E: no xvfb\n", offset: 11 });
      if (reads === 1) return json(200, { status: "building", data: "step 1\n", offset: 7 });
      return json(200, { status: "succeeded", data: "step 2\n", offset: 14, template: { name: "agentrun-box", revision: 4, image_digest: "sha256:new" } });
    }
    return json(404, { error: { code: "not_found", message: "No such route" } });
  };
  return { fetch, calls };
}

test("the Agent37 build's recipe is box/Dockerfile plus Xvfb, xfwm4 and the apps, named agentrun-box, its hash over every copied file and the desktop's lines", async () => {
  const { AGENT37_BOX_TEMPLATE } = await import("../dist/index.js");
  const { WINDOW_MANAGER } = await import("../dist/desktop.js");
  const { DESKTOP_APPS } = await import("../dist/conformance/cases/apps.js");
  assert.equal(agent37Build.NAME, AGENT37_BOX_TEMPLATE, "the descriptor's desktop image is the template this builds");
  const copied = INSTRUCTIONS.filter((line) => line.startsWith("COPY ")).map((line) => line.split(/\s+/)[1]);
  assert.deepEqual([...agent37Build.RECIPE].sort(), ["Dockerfile", ...copied].sort());
  assert.ok(agent37Build.DESKTOP.includes(`apt-get install -y -qq --no-install-recommends ${agent37Build.DESKTOP_PACKAGES.join(" ")} >/dev/null`));
  for (const name of ["xvfb", "xfwm4", "xfce4-terminal", "mousepad", "firefox-esr", "xdotool"]) assert.ok(agent37Build.DESKTOP_PACKAGES.includes(name), name);
  const programs = agent37Build.DESKTOP.match(/for x in ([^;]*); do command -v "\$x"/)?.[1].split(" ") ?? [];
  assert.ok(programs.includes("Xvfb"), "the build checks the X server is there");
  for (const program of WINDOW_MANAGER.filter((arg) => !arg.startsWith("-"))) assert.ok(programs.includes(program), `the build checks the window manager's ${program} is there`);
  const checked = agent37Build.DESKTOP.match(/for app in ([^;]*); do/)?.[1].split(" ") ?? [];
  assert.ok(checked.some((app) => DESKTOP_APPS.includes(app)), "the build checks a desktop file the conformance apps case opens");
  assert.match(agent37Build.DESKTOP, /! command -v sudo/, "the desktop's packages bring no sudo, checked");
  const recipe = agent37Build.recipeOf();
  assert.match(recipe.hash, /^[0-9a-f]{12}$/);
  const context = untar(agent37Build.contextOf(recipe));
  assert.deepEqual(Object.keys(context).sort(), ["Dockerfile", "agentrun-archil"]);
  assert.equal(context.Dockerfile.body, DOCKERFILE + agent37Build.DESKTOP, "the context's Dockerfile is box/Dockerfile, then the desktop's lines");
  assert.equal(context.Dockerfile.mode, 0o644);
  assert.equal(context["agentrun-archil"].body, HELPER);
  assert.equal(context["agentrun-archil"].mode, 0o755);
  assert.match(agent37Build.descriptionOf(recipe.hash), new RegExp(`recipe ${recipe.hash}$`));
});

test("the Agent37 build creates the build, uploads the context without the key, starts it and reads its log until the template is published", async () => {
  const { fetch, calls } = fakeBuilds();
  const logged = [];
  const built = await agent37Build.build({ apiKey: AGENT37_KEY, fetch, apiUrl: "https://api.agent37.test", log: (text) => logged.push(text), pollMs: 1 });
  assert.deepEqual(built, { name: "agentrun-box", revision: 4, digest: "sha256:new" });
  assert.deepEqual(
    calls.map(({ method, path }) => `${method} ${path}`),
    ["GET /v1/templates/agentrun-box", "POST /v1/template-builds", "PUT /context?signed=1", "POST /v1/template-builds/tb_0123456789abcdef0123/start", "GET /v1/template-builds/tb_0123456789abcdef0123/logs?offset=0", "GET /v1/template-builds/tb_0123456789abcdef0123/logs?offset=7"],
  );
  const made = JSON.parse(calls[1].body);
  assert.equal(made.name, "agentrun-box");
  assert.equal(made.description, agent37Build.descriptionOf(agent37Build.recipeOf().hash));
  assert.equal(made.size_bytes, calls[2].body.length, "size_bytes is the uploaded context's");
  assert.equal(calls[2].auth, undefined, "the presigned upload gets no Agent37 key");
  assert.ok(logged.join("").includes("step 1\nstep 2\n"), "the build's log, as it comes");
});

test("the Agent37 build builds nothing when the template already names this recipe, and a failed build fails in Agent37's words with no key", async () => {
  const current = fakeBuilds({ description: agent37Build.descriptionOf(agent37Build.recipeOf().hash) });
  assert.deepEqual(await agent37Build.build({ apiKey: AGENT37_KEY, fetch: current.fetch, apiUrl: "https://api.agent37.test", log: () => {} }), { name: "agentrun-box", revision: 3, digest: "sha256:old" });
  assert.deepEqual(current.calls.map(({ method, path }) => `${method} ${path}`), ["GET /v1/templates/agentrun-box"]);
  const stale = fakeBuilds({ description: agent37Build.descriptionOf("000000000000") });
  assert.equal((await agent37Build.build({ apiKey: AGENT37_KEY, fetch: stale.fetch, apiUrl: "https://api.agent37.test", log: () => {}, pollMs: 1 })).revision, 4, "another recipe's template is built again");
  const failing = fakeBuilds({ fail: true });
  await assert.rejects(agent37Build.build({ apiKey: AGENT37_KEY, fetch: failing.fetch, apiUrl: "https://api.agent37.test", log: () => {}, pollMs: 1 }), /failed: build_failed: step 3 exited 100/);
  await assert.rejects(agent37Build.build({ apiKey: "fake-test-key", fetch: failing.fetch, apiUrl: "https://api.agent37.test", log: () => {} }), (error) => /401 invalid_api_key/.test(error.message) && !error.message.includes("fake-test-key"));
  await assert.rejects(agent37Build.build({ apiKey: "", fetch: failing.fetch }), /set AGENT37_API_KEY/);
});

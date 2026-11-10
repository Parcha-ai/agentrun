// The Orgo template build (box/build-orgo.mjs): this folder's recipe written as Orgo's orgo.ai/v1 install steps, and
// its publish and build through Orgo's template API, against a fake fetch. No Orgo, no network: the steps are read as
// text, as box-recipe.test.mjs reads the Dockerfile. What only a live build proves (the steps run on Orgo's desktop, as
// root, and the preflight passes in a computer launched from it) is named in the PR.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ARCHIL_HELPER, ARCHIL_TOOL_UID, ARCHIL_TOOL_USER, ARCHIL_VERSION } from "../dist/index.js";
import { orgoTemplate, publishTemplate, TEMPLATE_NAME } from "../box/build-orgo.mjs";

const BOX = fileURLToPath(new URL("../box/", import.meta.url));
const DOCKERFILE = readFileSync(join(BOX, "Dockerfile"), "utf8");
const HELPER_BYTES = readFileSync(join(BOX, "agentrun-archil"));
const arg = (name) => new RegExp(`^ARG ${name}=(\\S+)$`, "m").exec(DOCKERFILE)[1];
const KEY = "sk_fake_orgo_key_0123456789abcdef";
const API = "https://orgo.example/api";

test("the Orgo template is the recipe's: the Dockerfile's archil pins, fuse3, the tool user, /workspace, the helper's own bytes root:root 0755, no sudo, then the checks", () => {
	const { name, version, document } = orgoTemplate();
	assert.equal(name, TEMPLATE_NAME);
	assert.equal(document.api_version, "orgo.ai/v1");
	assert.deepEqual([document.template.name, document.template.version], [name, version]);
	assert.match(version, /^1\.0\.0-r[0-9a-f]{12}$/, "semver, the document's hash");
	assert.deepEqual(Object.keys(document).sort(), ["api_version", "build", "template"], "no files section: Orgo reserves /usr/local/sbin and /tmp there");
	const steps = document.build.run;
	assert.ok(steps.length > 0 && steps.length <= 64, "Orgo takes up to 64 run steps");
	for (const step of steps) assert.ok(step.startsWith("set -eu; "), `each step fails the build on a failed command: ${step.slice(0, 60)}`);
	const all = steps.join("\n");

	assert.equal(arg("ARCHIL_VERSION"), ARCHIL_VERSION, "the Dockerfile pins the version the provider checks");
	assert.ok(all.includes(`archil_${ARCHIL_VERSION}_\${arch}.deb`));
	assert.ok(all.includes(`amd64) sum=${arg("ARCHIL_SHA256_AMD64")} ;;`) && all.includes(`arm64) sum=${arg("ARCHIL_SHA256_ARM64")} ;;`), "the Dockerfile's sums, the one place they are written");
	assert.ok(all.indexOf('echo "$sum  /tmp/archil.deb" | sha256sum -c -') < all.indexOf("apt-get install -y -qq --no-install-recommends /tmp/archil.deb"), "checked before it is installed");
	assert.match(all, /apt-get install [^;]* fuse3[ ;>]/);

	assert.ok(all.includes(`groupadd --gid ${ARCHIL_TOOL_UID} ${ARCHIL_TOOL_USER}`));
	assert.ok(all.includes(`useradd --uid ${ARCHIL_TOOL_UID} --gid ${ARCHIL_TOOL_UID} --no-create-home --home-dir /tmp --shell /bin/sh ${ARCHIL_TOOL_USER}`));
	assert.ok(all.includes("install -d -o root -g root -m 0755 /workspace"));

	// The helper: these bytes, checked by sha256 before they take the path the provider runs.
	const encoded = /echo '([A-Za-z0-9+/=]+)' \| base64 -d > (\S+)\.part/.exec(all);
	assert.ok(encoded, "the helper is written from the script's bytes");
	assert.equal(encoded[2], ARCHIL_HELPER);
	assert.deepEqual(Buffer.from(encoded[1], "base64"), HELPER_BYTES);
	const sha = createHash("sha256").update(HELPER_BYTES).digest("hex");
	assert.ok(all.includes(`echo "${sha}  ${ARCHIL_HELPER}.part" | sha256sum -c -`));
	const helperStep = steps.find((step) => step.includes("base64 -d"));
	const order = [`sha256sum -c -`, `chown root:root ${ARCHIL_HELPER}.part`, `chmod 0755 ${ARCHIL_HELPER}.part`, `mv -f ${ARCHIL_HELPER}.part ${ARCHIL_HELPER}`].map((words) => helperStep.indexOf(words));
	assert.deepEqual([...order].sort((a, b) => a - b), order, "checked, made root's 0755, then moved into place");
	assert.ok(order.every((at) => at > 0));

	// No way to root: sudo and sudoers taken away, then the Dockerfile's guards, last.
	const purge = all.indexOf("apt-get purge -y -qq sudo");
	const guard = all.indexOf("! command -v sudo >/dev/null 2>&1 || { echo \"the image has sudo\" >&2; exit 1; }");
	assert.ok(purge > 0 && purge < guard && all.indexOf("rm -rf /etc/sudoers /etc/sudoers.d") < guard);
	assert.ok(all.includes("[ ! -e /etc/sudoers ] && [ ! -e /etc/sudoers.d ] || { echo \"the image has a sudoers file\" >&2; exit 1; }"));
	assert.ok(all.includes(`[ "$ids" = "${ARCHIL_TOOL_UID}:${ARCHIL_TOOL_UID}" ]`));
	assert.ok(all.includes(`[ "$(stat -c '%U:%G %a' ${ARCHIL_HELPER})" = "root:root 755" ]`));
	assert.ok(all.includes(`grep -F "v${ARCHIL_VERSION}"`), "the client reads back the pinned version");
	assert.ok(steps.at(-1).includes("! command -v sudo"), "the checks are the last step");
	for (const program of ["/usr/bin/archil", "/usr/bin/mount", "/usr/bin/chown", "/usr/bin/realpath"]) assert.ok(all.includes(program), program);
	assert.ok(!/iptables/.test(all), "no firewall: the tools' network is init's own namespace");
});

test("the Orgo template's version is its document's hash: the same recipe is the same version, a changed helper or pin a new one; an unpinned sum stops it in words", () => {
	assert.deepEqual(orgoTemplate(), orgoTemplate());
	const dir = mkdtempSync(join(tmpdir(), "box-orgo-"));
	try {
		cpSync(BOX, dir, { recursive: true });
		writeFileSync(join(dir, "agentrun-archil"), Buffer.concat([HELPER_BYTES, Buffer.from("# changed\n")]));
		assert.notEqual(orgoTemplate({ dir }).version, orgoTemplate().version);
		writeFileSync(join(dir, "Dockerfile"), DOCKERFILE.replace(/^ARG ARCHIL_SHA256_ARM64=\S+$/m, "ARG ARCHIL_SHA256_ARM64=unpinned"));
		assert.throws(() => orgoTemplate({ dir }), /arm64 has no pinned sha256 in the Dockerfile \(unpinned\)/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** A fake of Orgo's template API: validate, publish, build, and the build's status, reading `building` reads times. */
function fakeTemplates({ validate = 200, publish = 200, build = 200, building = 1, outcome = { status: "ready" }, echo = false } = {}) {
	const requests = [];
	let reads = 0;
	const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	const fetch = async (url, init = {}) => {
		const path = new URL(url).pathname.replace(/^\/api/, "");
		const headers = Object.fromEntries(new Headers(init.headers).entries());
		requests.push({ method: init.method ?? "GET", path, headers, body: init.body === undefined ? undefined : JSON.parse(init.body) });
		if (headers.authorization !== `Bearer ${KEY}`) return json(401, { error: "Invalid API key" });
		const route = `${init.method ?? "GET"} ${path}`;
		if (route === "POST /templates/validate") return validate === 200 ? json(200, { ok: true }) : json(422, { ok: false, errors: [{ field: "build.run[0]", code: "invalid_value", message: "too long" }] });
		if (route === "POST /templates") {
			if (publish === 403) return json(403, { error: `Upgrade required${echo ? ` for ${headers.authorization}` : ""}`, code: "UPGRADE_REQUIRED", upgradeTier: "scale_v2" });
			const { name, version } = JSON.parse(init.body).template;
			return json(200, { ref: `default/${name}@${version}`, digest: "a".repeat(64), published: new Date().toISOString() });
		}
		if (/^POST \/templates\/default\/[^/]+\/[^/]+\/build$/.test(route)) return build === 200 ? json(200, { queued: true, status: "queued" }) : json(build, { error: "No such version", code: "not_published" });
		if (/^GET \/templates\/default\/[^/]+\/[^/]+\/build$/.test(route)) return json(200, reads++ < building ? { status: "building", phase: "queued" } : outcome);
		return json(404, { error: `no route ${route}` });
	};
	return { fetch, requests };
}

test("publishTemplate: validate, publish, build, then the build's status until ready, the key in the Authorization header alone; the ref is the published one", async () => {
	const { document, name, version } = orgoTemplate();
	const api = fakeTemplates({ building: 2 });
	const lines = [];
	const ref = await publishTemplate({ document, apiKey: KEY, apiUrl: API, fetch: api.fetch, pollMs: 1, log: (line) => lines.push(line) });
	assert.equal(ref, `default/${name}@${version}`);
	assert.deepEqual(
		api.requests.map(({ method, path }) => `${method} ${path}`),
		["POST /templates/validate", "POST /templates", `POST /templates/default/${name}/${version}/build`, ...Array(3).fill(`GET /templates/default/${name}/${version}/build`)],
	);
	assert.deepEqual(api.requests[0].body, document);
	assert.deepEqual(api.requests[1].body, document);
	assert.ok(api.requests.every(({ headers }) => headers.authorization === `Bearer ${KEY}`));
	assert.ok(!JSON.stringify(api.requests.map(({ path, body }) => ({ path, body }))).includes(KEY), "nowhere but the header");
	assert.ok(!lines.join("\n").includes(KEY));
});

test("publishTemplate refuses in words that never hold the key: no key, an http URL, a template Orgo finds invalid, a plan below Scale, a failed build, a build that never ends", async () => {
	const { document } = orgoTemplate();
	const quiet = { pollMs: 1, log: () => {} };
	await assert.rejects(publishTemplate({ document, apiKey: "", fetch: fakeTemplates().fetch, ...quiet }), /ORGO_API_KEY/);
	await assert.rejects(publishTemplate({ document, apiKey: KEY, apiUrl: "http://orgo.example/api", fetch: fakeTemplates().fetch, ...quiet }), /https/);
	for (const [options, words] of [
		[{ validate: 422 }, /validating the template was refused: 422: invalid: build\.run\[0\]: too long/],
		[{ publish: 403, echo: true }, /publishing the template was refused: 403 UPGRADE_REQUIRED: .*Scale plan/],
		[{ build: 409 }, /building default\/agentrun-archil@.* was refused: 409 not_published/],
		[{ outcome: { status: "failed", error: "build.run[0]: exit 100" } }, /build of default\/agentrun-archil@.* failed: build\.run\[0\]: exit 100/],
		[{ outcome: { status: "not_built" } }, /cancelled/],
		[{ building: 1_000_000 }, /was not built within/],
	]) {
		const api = fakeTemplates(options);
		const failed = await publishTemplate({ document, apiKey: KEY, apiUrl: API, fetch: api.fetch, timeoutMs: 20, ...quiet }).then(
			() => assert.fail(`${JSON.stringify(options)} resolved`),
			(error) => error,
		);
		assert.match(failed.message, words);
		assert.ok(!failed.message.includes(KEY), `${JSON.stringify(options)}: the words hold the key`);
	}
});

test("build-orgo.mjs --print prints the template document and calls nothing, with no key set", () => {
	const printed = spawnSync(process.execPath, [join(BOX, "build-orgo.mjs"), "--print"], { encoding: "utf8", env: { PATH: process.env.PATH } });
	assert.equal(printed.status, 0, printed.stderr);
	assert.deepEqual(JSON.parse(printed.stdout), orgoTemplate().document);
	const missing = spawnSync(process.execPath, [join(BOX, "build-orgo.mjs")], { encoding: "utf8", env: { PATH: process.env.PATH } });
	assert.equal(missing.status, 1);
	assert.match(missing.stderr, /set ORGO_API_KEY/);
});

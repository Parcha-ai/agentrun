// Build the Archil image as an Orgo template (orgo.ai/v1), with the Orgo API key in ORGO_API_KEY, and print its ref,
// namespace/name@version: an Orgo computer with an Archil mount names it as its spec's image (template_ref). Orgo
// builds a template from install steps, not a Dockerfile, so this script writes this folder's recipe as those steps,
// run as root on Orgo's own desktop: the archil client pinned by the Dockerfile's version and sha256 (read from its
// ARG lines, the one place they are written), fuse3, the tool user agentrun-tool 2510:2510, an empty root-owned
// /workspace, the root helper (this folder's agentrun-archil, written from the script's bytes and checked by sha256)
// root:root 0755 at /usr/local/sbin/agentrun-archil, then no sudo and no sudoers file, then the Dockerfile's checks.
// Orgo's files section cannot write under /usr/local/sbin (its own binaries) or /tmp, so the helper goes in through a
// build step. The version is the document's own hash, so a changed recipe is a new version and the same one is the
// template built before. Publishing and building need Orgo's Scale plan; reading a build's status does not.
//
//   ORGO_API_KEY=... node packages/computer/box/build-orgo.mjs           validate, publish, build, wait, print the ref
//   node packages/computer/box/build-orgo.mjs --print                     print the template document, call nothing
//
// ORGO_API_URL names another Orgo API (https); default https://www.orgo.ai/api. The key is sent in the Authorization
// header alone and never printed.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** The template's name in the publisher's namespace. */
export const TEMPLATE_NAME = "agentrun-archil";
/** Where the helper is installed, as the provider runs it (ARCHIL_HELPER). */
const HELPER = "/usr/local/sbin/agentrun-archil";
const DEFAULT_API_URL = "https://www.orgo.ai/api";

/** The Dockerfile's ARG value for name, or a throw naming it. */
function argOf(dockerfile, name) {
	const value = new RegExp(`^ARG ${name}=(\\S+)$`, "m").exec(dockerfile)?.[1];
	if (value === undefined) throw new Error(`build-orgo: the Dockerfile has no ARG ${name}`);
	return value;
}

/**
 * The orgo.ai/v1 template document (canonical form) for this folder's recipe, and its ref's name and version. Every
 * build step runs with set -eu, so a failed step fails the build.
 */
export function orgoTemplate({ dir = here } = {}) {
	const dockerfile = readFileSync(join(dir, "Dockerfile"), "utf8");
	const helper = readFileSync(join(dir, "agentrun-archil"));
	const version = argOf(dockerfile, "ARCHIL_VERSION");
	const amd64 = argOf(dockerfile, "ARCHIL_SHA256_AMD64");
	const arm64 = argOf(dockerfile, "ARCHIL_SHA256_ARM64");
	for (const [arch, sum] of [["amd64", amd64], ["arm64", arm64]]) {
		if (!/^[0-9a-f]{64}$/.test(sum)) throw new Error(`build-orgo: archil ${version} for ${arch} has no pinned sha256 in the Dockerfile (${sum}): pin it before any build`);
	}
	const helperSha = createHash("sha256").update(helper).digest("hex");
	const run = [
		// The archil client, by the Dockerfile's version and sha256, and FUSE.
		[
			"set -eu",
			'arch="$(dpkg --print-architecture)"',
			`case "$arch" in amd64) sum=${amd64} ;; arm64) sum=${arm64} ;; *) echo "no archil client for $arch" >&2; exit 1 ;; esac`,
			"export DEBIAN_FRONTEND=noninteractive",
			"apt-get update -qq",
			"apt-get install -y -qq --no-install-recommends curl ca-certificates fuse3 >/dev/null",
			`curl -fsSL -o /tmp/archil.deb "https://s3.amazonaws.com/archil-client/pkg/archil_${version}_\${arch}.deb"`,
			'echo "$sum  /tmp/archil.deb" | sha256sum -c -',
			"apt-get install -y -qq --no-install-recommends /tmp/archil.deb >/dev/null",
			"rm -rf /var/lib/apt/lists/* /tmp/archil.deb",
		].join("; "),
		// The tool user computerd runs every tool as, and the folder the helper mounts the run's folder at.
		["set -eu", "groupadd --gid 2510 agentrun-tool", "useradd --uid 2510 --gid 2510 --no-create-home --home-dir /tmp --shell /bin/sh agentrun-tool", "install -d -o root -g root -m 0755 /workspace"].join("; "),
		// The root helper, these bytes, checked by sha256 before it takes its path.
		[
			"set -eu",
			`echo '${helper.toString("base64")}' | base64 -d > ${HELPER}.part`,
			`echo "${helperSha}  ${HELPER}.part" | sha256sum -c -`,
			`chown root:root ${HELPER}.part`,
			`chmod 0755 ${HELPER}.part`,
			`mv -f ${HELPER}.part ${HELPER}`,
		].join("; "),
		// No way to root for the tool user: Orgo's desktop may bring sudo for its own user; it is taken away, then checked.
		["set -eu", "if dpkg -s sudo >/dev/null 2>&1; then SUDO_FORCE_REMOVE=yes DEBIAN_FRONTEND=noninteractive apt-get purge -y -qq sudo >/dev/null; fi", "rm -rf /etc/sudoers /etc/sudoers.d"].join("; "),
		// The Dockerfile's checks: what the helper runs, no sudo, the tool user's ids, the client's version.
		[
			"set -eu",
			'for x in /usr/bin/archil /usr/bin/awk /usr/bin/realpath /usr/bin/mount /usr/bin/chown /usr/bin/find /usr/bin/id /usr/bin/ls; do [ -x "$x" ] || { echo "the image has no $x" >&2; exit 1; }; done',
			'! command -v sudo >/dev/null 2>&1 || { echo "the image has sudo" >&2; exit 1; }',
			'[ ! -e /etc/sudoers ] && [ ! -e /etc/sudoers.d ] || { echo "the image has a sudoers file" >&2; exit 1; }',
			'ids="$(id -u agentrun-tool):$(id -g agentrun-tool)"',
			'[ "$ids" = "2510:2510" ] || { echo "agentrun-tool is $ids" >&2; exit 1; }',
			`[ "$(stat -c '%U:%G %a' ${HELPER})" = "root:root 755" ] || { echo "the helper is not root:root 0755" >&2; exit 1; }`,
			`archil --version | head -1 | grep -F "v${version}"`,
		].join("; "),
	];
	const body = { api_version: "orgo.ai/v1", template: { name: TEMPLATE_NAME, description: "agentrun's Archil desktop: the archil client, the root helper and the tool user, no sudo (packages/computer/box)." }, build: { run } };
	const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 12);
	const templateVersion = `1.0.0-r${hash}`;
	return { name: TEMPLATE_NAME, version: templateVersion, document: { ...body, template: { ...body.template, version: templateVersion } } };
}

/** An Orgo answer in words, never the key: its status, code and error, or its field errors. */
async function answerWords(response) {
	const text = await response.text().catch(() => "");
	let read;
	try {
		read = JSON.parse(text);
	} catch {
		return `${response.status}: ${text.replace(/\s+/g, " ").slice(0, 300)}`;
	}
	const errors = Array.isArray(read?.errors) ? `: ${read.errors.map((one) => `${one.field}: ${one.message}`).join("; ")}` : "";
	return `${response.status}${read?.code ? ` ${read.code}` : ""}: ${read?.error ?? "invalid"}${errors}`.slice(0, 1000);
}

/**
 * Validates, publishes and builds the document in the key's own namespace, then waits for the build; resolves the ref
 * once Orgo reads it ready, and throws in words (never the key) when a step is refused, the build fails, or timeoutMs
 * passes.
 */
export async function publishTemplate({ document, apiKey, apiUrl = DEFAULT_API_URL, fetch: fetchFn = globalThis.fetch, pollMs = 10_000, timeoutMs = 45 * 60_000, log = (line) => console.error(line) }) {
	if (typeof apiKey !== "string" || apiKey === "") throw new Error("build-orgo: set ORGO_API_KEY to an Orgo API key on the Scale plan (publishing and building templates need it)");
	const base = new URL(apiUrl);
	if (base.protocol !== "https:" || base.username !== "" || base.password !== "") throw new Error("build-orgo: the Orgo API URL must be https, with no credentials in it: the key goes to it");
	const url = (path) => `${base.href.replace(/\/$/, "")}${path}`;
	const call = (method, path, body) =>
		fetchFn(url(path), { method, headers: { authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
	const refuse = async (what, response) => {
		const words = (await answerWords(response)).replaceAll(apiKey, "[key]");
		const plan = response.status === 403 ? " (publishing and building templates need Orgo's Scale plan)" : "";
		return new Error(`build-orgo: ${what} was refused: ${words}${plan}`);
	};

	const valid = await call("POST", "/templates/validate", document);
	if (!valid.ok) throw await refuse("validating the template", valid);
	const published = await call("POST", "/templates", document);
	if (!published.ok) throw await refuse("publishing the template", published);
	const { ref } = await published.json();
	const parts = /^([^/]+)\/([^@]+)@(.+)$/.exec(String(ref));
	if (parts === null) throw new Error(`build-orgo: Orgo published the template as ${JSON.stringify(ref)}, not namespace/name@version`);
	const [, namespace, name, version] = parts;
	log(`build-orgo: published ${ref}`);
	const buildPath = `/templates/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/${encodeURIComponent(version)}/build`;
	const started = await call("POST", buildPath);
	if (!started.ok) throw await refuse(`building ${ref}`, started);
	const until = Date.now() + timeoutMs;
	for (;;) {
		const read = await call("GET", buildPath);
		if (!read.ok) throw await refuse(`reading ${ref}'s build`, read);
		const { status, error, phase } = await read.json();
		if (status === "ready") return ref;
		if (status === "failed") throw new Error(`build-orgo: Orgo's build of ${ref} failed: ${String(error ?? "no reason given").replaceAll(apiKey, "[key]").slice(0, 1000)}`);
		if (status === "not_built") throw new Error(`build-orgo: Orgo reads ${ref} not built: its build was cancelled`);
		if (Date.now() >= until) throw new Error(`build-orgo: ${ref} was not built within ${timeoutMs / 60_000} min; it last read ${status}${phase ? ` (${phase})` : ""}`);
		log(`build-orgo: ${ref} ${status}${phase ? ` (${phase})` : ""}`);
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const { document } = orgoTemplate();
	if (process.argv.includes("--print")) {
		console.log(JSON.stringify(document, null, 2));
	} else {
		try {
			const ref = await publishTemplate({ document, apiKey: process.env.ORGO_API_KEY, apiUrl: process.env.ORGO_API_URL || DEFAULT_API_URL });
			console.log(`template=${ref}`);
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	}
}

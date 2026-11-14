// Build the box image (this folder's Dockerfile, plus Xvfb, xfwm4 and apps for a desktop) as a template of an Agent37 workspace, through
// Agent37's cloud build, with the workspace's key in AGENT37_API_KEY, and print the template's name: an Agent37 desktop
// starts from it (src/descriptors/agent37.ts AGENT37_BOX_TEMPLATE), and so can an Archil computer.
//
// Agent37 keeps a template's revisions under one name (docs: agents-api/templates), so the name is fixed, agentrun-box,
// and the recipe's hash (the Dockerfile, the files it copies and DESKTOP below) goes in the template's description: a
// workspace whose template already names this hash is built nothing, and a changed recipe publishes a new revision,
// which every instance made after it starts from. Builds are free, at most three at once per workspace and 45 minutes
// each. The calls, in order (docs: templates, "Build an image in the cloud"):
//
//   GET  /v1/templates/agentrun-box               its description, or 404
//   POST /v1/template-builds                       { name, size_bytes, description } -> { id, upload_url }
//   PUT  <upload_url>                              the gzipped context, Dockerfile at its root, no Agent37 key
//   POST /v1/template-builds/{id}/start
//   GET  /v1/template-builds/{id}/logs?offset=N    until status succeeded or failed (a poll registers the template)
//
//   AGENT37_API_KEY=... node packages/computer/box/build-agent37.mjs
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/** The template's name in every workspace: AGENT37_BOX_TEMPLATE. */
export const NAME = "agentrun-box";
export const API_URL = "https://api.agent37.com";
/** Every file the image is made of besides DESKTOP: the Dockerfile and what it copies, as build-e2b.mjs hashes them. */
export const RECIPE = ["Dockerfile", "agentrun-archil"];
/**
 * What a desktop adds to box/Dockerfile: Xvfb and xfwm4, which the provider starts through computerd as the tool user on
 * :0 (src/desktop.ts), and the apps E2B Desktop has that are cheap to carry: Xfce's terminal and text editor, Firefox
 * ESR, and xdotool. computerd's apps group lists and opens them by their desktop files. Nothing starts here, and no VNC
 * server or sudo comes with it.
 */
export const DESKTOP_PACKAGES = ["xvfb", "xfwm4", "xfce4-terminal", "mousepad", "firefox-esr", "xdotool", "fonts-dejavu-core", "adwaita-icon-theme"];
export const DESKTOP = `
# A desktop (build-agent37.mjs): Xvfb and xfwm4, which the provider starts through computerd as the tool user on :0, and
# the apps an agent opens.
RUN set -eu; \\
    apt-get update -qq; \\
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ${DESKTOP_PACKAGES.join(" ")} >/dev/null; \\
    rm -rf /var/lib/apt/lists/*; \\
    for x in Xvfb xfwm4 xfce4-terminal mousepad firefox-esr xdotool; do command -v "$x" >/dev/null || { echo "the image has no $x" >&2; exit 1; }; done; \\
    for app in org.xfce.mousepad xfce4-terminal firefox-esr; do [ -f "/usr/share/applications/$app.desktop" ] || { echo "the image has no desktop file $app.desktop" >&2; exit 1; }; done; \\
    ! command -v sudo >/dev/null 2>&1 || { echo "the image has sudo" >&2; exit 1; }
`;
/** How often a build's log is read, and the longest a build is waited for: Agent37's 45 minutes, and some. */
const POLL_MS = 5_000;
const BUILD_MS = 50 * 60_000;

const here = dirname(fileURLToPath(import.meta.url));

/** The recipe's files, read from dir, with the context's Dockerfile (box/Dockerfile and DESKTOP), and its 12-hex hash. */
export function recipeOf(dir = here) {
	const files = Object.fromEntries(RECIPE.map((name) => [name, readFileSync(join(dir, name))]));
	const dockerfile = Buffer.concat([files.Dockerfile, Buffer.from(DESKTOP)]);
	const hash = createHash("sha256")
		.update(Buffer.concat([...RECIPE.map((name) => files[name]), Buffer.from(DESKTOP)]))
		.digest("hex")
		.slice(0, 12);
	return { hash, files: { ...files, Dockerfile: dockerfile } };
}

/** The template's description: the recipe's hash is how a later build knows this one is current. */
export const descriptionOf = (hash) => `AgentRun's box image (Archil client and helper, tool user, Xvfb, xfwm4 and apps), recipe ${hash}`;

/** One ustar header block: a file at the archive's root, owned by root. */
function header(name, mode, size) {
	const block = Buffer.alloc(512);
	const octal = (value, width) => `${value.toString(8).padStart(width - 1, "0")}\0`;
	block.write(name, 0, 100);
	block.write(octal(mode, 8), 100);
	block.write(octal(0, 8), 108);
	block.write(octal(0, 8), 116);
	block.write(octal(size, 12), 124);
	block.write(octal(0, 12), 136);
	block.write("        ", 148);
	block.write("0", 156);
	block.write("ustar\0", 257);
	block.write("00", 263);
	let sum = 0;
	for (const byte of block) sum += byte;
	block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
	return block;
}

/** The build's context: a gzipped tar of the Dockerfile (0644) and the helper (0755), at its root. */
export function contextOf({ files }) {
	const parts = [];
	for (const [name, mode] of [
		["Dockerfile", 0o644],
		["agentrun-archil", 0o755],
	]) {
		const body = files[name];
		parts.push(header(name, mode, body.length), body, Buffer.alloc((512 - (body.length % 512)) % 512));
	}
	parts.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(parts));
}

/** An answer that is not a success, in Agent37's words (its envelope's code and message), never with the key. */
async function failure(what, response) {
	const text = await response.text().catch(() => "");
	let error;
	try {
		error = JSON.parse(text)?.error;
	} catch {
		// Not JSON: its status alone.
	}
	const code = typeof error === "string" ? error : error?.code;
	const message = typeof error === "object" ? error?.message : undefined;
	return new Error(`${what} answered ${response.status}${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}`);
}

/**
 * Builds the recipe as the template NAME unless the workspace's template already names its hash, and answers the
 * template's name, revision and digest (revision and digest undefined when nothing was built). log gets the build's
 * log as it comes.
 */
export async function build({ apiKey, fetch = globalThis.fetch, apiUrl = API_URL, dir = here, log = (text) => process.stderr.write(text), pollMs = POLL_MS, buildMs = BUILD_MS }) {
	if (typeof apiKey !== "string" || apiKey === "") throw new Error("set AGENT37_API_KEY to the workspace's Agent37 API key, for this one command");
	const auth = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
	const rest = async (method, path, body) => {
		const response = await fetch(`${apiUrl}${path}`, {
			method,
			headers: { ...auth, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(60_000),
		});
		if (!response.ok) throw await failure(`${method} ${path}`, response);
		return response.json();
	};
	const recipe = recipeOf(dir);
	const description = descriptionOf(recipe.hash);
	log(`build-agent37: template ${NAME}, recipe ${recipe.hash}\n`);

	const current = await fetch(`${apiUrl}/v1/templates/${NAME}`, { headers: auth, signal: AbortSignal.timeout(60_000) });
	if (current.ok) {
		const template = await current.json();
		if (template?.description === description) {
			log(`build-agent37: ${NAME} revision ${template.revision} is this recipe already; nothing built\n`);
			return { name: NAME, revision: template.revision, digest: template.image_digest };
		}
	} else if (current.status !== 404) {
		throw await failure(`GET /v1/templates/${NAME}`, current);
	}

	const context = contextOf(recipe);
	const made = await rest("POST", "/v1/template-builds", { name: NAME, size_bytes: context.length, description });
	if (typeof made?.id !== "string" || typeof made?.upload_url !== "string") throw new Error("POST /v1/template-builds answered no id or upload_url");
	log(`build-agent37: build ${made.id}, context ${context.length} bytes\n`);
	// The presigned URL takes no Agent37 key, and fetch sends no Expect header.
	const uploaded = await fetch(made.upload_url, { method: "PUT", body: context, headers: { "Content-Type": "application/gzip" }, signal: AbortSignal.timeout(300_000) });
	if (!uploaded.ok) throw await failure("the context's upload", uploaded);
	await rest("POST", `/v1/template-builds/${made.id}/start`, {});

	const end = Date.now() + buildMs;
	let offset = 0;
	for (;;) {
		const read = await rest("GET", `/v1/template-builds/${made.id}/logs?offset=${offset}`);
		if (typeof read?.data === "string" && read.data !== "") log(read.data);
		if (Number.isSafeInteger(read?.offset)) offset = read.offset;
		if (read?.status === "succeeded") {
			const { name = NAME, revision, image_digest: digest } = read.template ?? {};
			log(`\nbuild-agent37: ${name} revision ${revision}, ${digest}\n`);
			return { name, revision, digest };
		}
		if (read?.status === "failed") throw new Error(`build ${made.id} failed: ${read.error?.code ?? "no code"}${read.error?.message ? `: ${read.error.message}` : ""}`);
		if (Date.now() > end) throw new Error(`build ${made.id} was not done within ${buildMs / 60_000} minutes (status ${read?.status}); Agent37 ends a build at 45`);
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
}

if (import.meta.main) {
	try {
		const { name } = await build({ apiKey: process.env.AGENT37_API_KEY });
		console.log(`template=${name}`);
	} catch (error) {
		console.error(`build-agent37: ${error.message}`);
		process.exit(1);
	}
}

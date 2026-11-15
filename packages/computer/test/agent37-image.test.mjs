// Agent37's prepareImage on a fake Agent37 REST: the box image the release publishes (ghcr.io/parcha-ai/agentrun-box,
// tagged with the box recipe's hash) registered as a template of the key's own workspace, agentrun-box-<hash>, the first
// time a workspace needs it. GET, then on a 404 a POST from the public image (onWait told "pull" first); a template the
// workspace has already is used as it is; a 409 is another registration of the same name, waited for; a refusal is the
// claim's error in Agent37's words.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { API_URL, fakeRest, KEY, keyPair, PROXY } from "./fake-agent37.mjs";

const { Agent37Provider } = await import("../dist/agent37.js");
const descriptors = await import("../dist/descriptors/index.js");
const { AGENT37 } = await import("../dist/descriptors/agent37.js");

const SSH_KEY = keyPair().private;
/** The box recipe's hash as box/recipe.mjs computes it: the Dockerfile, then the helper it copies, 12 hex. */
const HASH = createHash("sha256")
	.update(Buffer.concat(["Dockerfile", "agentrun-archil"].map((name) => readFileSync(new URL(`../box/${name}`, import.meta.url)))))
	.digest("hex")
	.slice(0, 12);
const NAME = `agentrun-box-${HASH}`;
const REF = `ghcr.io/parcha-ai/agentrun-box:${HASH}`;

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const envelope = (status, code, message) => json(status, { error: { code, message } });
const template = (name, image_ref) => ({ name, scope: "workspace", agents: [], revision: 1, image_ref, image_digest: `sha256:${"e".repeat(64)}`, description: null, default_port: null, entrypoint: null, created: 1_800_000_000, updated: 1_800_000_000 });

/**
 * The fake's instances, plus its templates: GET /v1/templates/{name} and POST /v1/templates as Agent37 answers them
 * (docs: agents-api/templates). `templates` holds the workspace's; `answers` answers the next matching call once, before
 * the workspace does.
 */
function withTemplates() {
	const rest = fakeRest();
	const templates = new Map();
	const answers = [];
	const fetch = async (url, init = {}) => {
		const { pathname } = new URL(url);
		const method = init.method ?? "GET";
		if (!pathname.startsWith("/v1/templates")) return rest.fetch(url, init);
		const body = init.body === undefined ? undefined : JSON.parse(init.body);
		rest.calls.push({ method, path: pathname, auth: init.headers?.Authorization, body });
		const queued = answers.findIndex((one) => one.method === method && one.path === pathname);
		if (queued >= 0) return answers.splice(queued, 1)[0].answer();
		if (init.headers?.Authorization !== `Bearer ${KEY}`) return envelope(401, "invalid_api_key", "Invalid API key");
		if (method === "POST" && pathname === "/v1/templates") {
			if (templates.has(body.name)) return envelope(409, "template_conflict", `A template named ${body.name} already exists`);
			const made = template(body.name, body.image_ref);
			templates.set(body.name, made);
			return json(201, made);
		}
		const name = /^\/v1\/templates\/([^/]+)$/.exec(pathname)?.[1];
		if (method === "GET" && name !== undefined) return templates.has(name) ? json(200, templates.get(name)) : envelope(404, "not_found", `No such template: ${name}`);
		return envelope(400, "invalid_request", `No ${method} here`);
	};
	const provider = new Agent37Provider({ apiKey: KEY, sshKey: SSH_KEY, ssh2: { Client: class {} }, fetch, apiUrl: API_URL, proxyDomain: PROXY });
	const said = () => rest.calls.filter(({ path }) => path.startsWith("/v1/templates")).map(({ method, path }) => `${method} ${path}`);
	return { provider, fetch, templates, calls: rest.calls, said, answer: (method, path, answer) => answers.push({ method, path, answer }) };
}

test("Agent37's descriptor says it prepares its image, and names no template of ours as a default", () => {
	assert.equal(AGENT37.prepareImage, true);
	assert.equal(AGENT37.defaultImage, undefined, "every Agent37 computer starts from the template prepareImage answers");
	assert.equal("AGENT37_BOX_TEMPLATE" in descriptors, false, "no fixed template name: the box template is named by its recipe's hash");
});

test("a workspace without the box template registers it from the public image, told as a pull, and answers its name", async () => {
	const { provider, templates, calls, said } = withTemplates();
	const waits = [];
	const ready = await provider.prepareImage({ onWait: (making, tag) => waits.push([making, tag]) });
	assert.deepEqual(ready, { ok: true, value: NAME });
	assert.deepEqual(said(), [`GET /v1/templates/${NAME}`, "POST /v1/templates"]);
	const posted = calls.find(({ method, path }) => method === "POST" && path === "/v1/templates");
	assert.equal(posted.body.name, NAME);
	assert.equal(posted.body.image_ref, REF);
	assert.equal(posted.auth, `Bearer ${KEY}`);
	assert.deepEqual(waits, [["pull", REF]], "the claim waits once, on a pull of the public image");
	assert.equal(templates.get(NAME).image_ref, REF);
});

test("a workspace that has the box template already registers nothing and waits on nothing", async () => {
	const { provider, templates, said } = withTemplates();
	templates.set(NAME, template(NAME, REF));
	const waits = [];
	assert.deepEqual(await provider.prepareImage({ onWait: (...args) => waits.push(args) }), { ok: true, value: NAME });
	assert.deepEqual(said(), [`GET /v1/templates/${NAME}`]);
	assert.deepEqual(waits, []);
});

test("a registration another claim made first (409) is waited for until the workspace has the template", async () => {
	const { provider, templates, said, answer } = withTemplates();
	answer("POST", "/v1/templates", () => envelope(409, "template_conflict", `A template named ${NAME} already exists`));
	// The other registration is still copying the image: the first read after the 409 finds nothing yet.
	let reads = 0;
	answer("GET", `/v1/templates/${NAME}`, () => envelope(404, "not_found", "No such template"));
	answer("GET", `/v1/templates/${NAME}`, () => {
		reads++;
		return envelope(404, "not_found", "No such template");
	});
	setTimeout(() => templates.set(NAME, template(NAME, REF)), 50);
	assert.deepEqual(await provider.prepareImage(), { ok: true, value: NAME });
	assert.equal(reads, 1);
	assert.deepEqual(said(), [`GET /v1/templates/${NAME}`, "POST /v1/templates", `GET /v1/templates/${NAME}`, `GET /v1/templates/${NAME}`]);
});

test("a registration Agent37 refuses is the claim's error, in Agent37's words and naming the image", async () => {
	const { provider, answer } = withTemplates();
	answer("POST", "/v1/templates", () => envelope(400, "invalid_request", `image_ref ${REF} could not be pulled: it is private or does not exist`));
	const refused = await provider.prepareImage();
	assert.equal(refused.ok, false);
	assert.equal(refused.error.code, "invalid");
	assert.match(refused.error.message, new RegExp(`registering ${REF.replace(/[.:]/g, "\\$&")} as the Agent37 template ${NAME}`));
	assert.match(refused.error.message, /POST \/v1\/templates answered 400 invalid_request: image_ref .* could not be pulled: it is private or does not exist/);
	assert.doesNotMatch(refused.error.message, new RegExp(KEY));
});

test("a read Agent37 refuses registers nothing: the key's refusal, in its words", async () => {
	const { provider, said, answer } = withTemplates();
	answer("GET", `/v1/templates/${NAME}`, () => envelope(401, "invalid_api_key", "Invalid API key"));
	const waits = [];
	const refused = await provider.prepareImage({ onWait: (...args) => waits.push(args) });
	assert.equal(refused.ok, false);
	assert.equal(refused.error.code, "denied");
	assert.match(refused.error.message, /GET \/v1\/templates\/agentrun-box-[0-9a-f]{12} answered 401 invalid_api_key: Invalid API key/);
	assert.deepEqual(said(), [`GET /v1/templates/${NAME}`]);
	assert.deepEqual(waits, []);
});

test("a desktop conformance run registers the box template under the run's own signal: Ctrl-C ends the wait", async () => {
	const { fetch, answer } = withTemplates();
	answer("POST", "/v1/templates", () => envelope(409, "template_conflict", "exists"));
	const { conformanceImage, AGENT37_ENV: ENV } = await import("../dist/conformance/agent37.js");
	const env = { [ENV.key]: KEY, [ENV.sshKey]: SSH_KEY, [ENV.live]: "1", [ENV.kind]: "desktop", [ENV.apiUrl]: API_URL };
	const stop = new AbortController();
	setTimeout(() => stop.abort(), 50);
	await assert.rejects(conformanceImage({ env, ssh2: { Client: class {} }, fetch }, { signal: stop.signal }), /the Agent37 box template: .*aborted/);
});

test("an aborted prepare stops waiting and says so", async () => {
	const { provider, answer } = withTemplates();
	answer("POST", "/v1/templates", () => envelope(409, "template_conflict", "exists"));
	const stop = new AbortController();
	setTimeout(() => stop.abort(), 50);
	const stopped = await provider.prepareImage({ signal: stop.signal });
	assert.equal(stopped.ok, false);
	assert.match(stopped.error.message, /agentrun-box-[0-9a-f]{12}/);
});

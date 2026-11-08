// The Archil run folder the mount cases use (src/conformance/archil.ts), against a fake S3-compatible endpoint: its
// settings by name, all five or none; an endpoint that is not https on an Archil host of the region is refused before
// the key goes anywhere; the folder's markers made, a file read and written by key, and the run's folder cleared.
import assert from "node:assert/strict";
import test from "node:test";
import { ARCHIL_ENV, archilFolder, archilSettingsFromEnv } from "../dist/conformance/archil.js";
import { mountFor } from "../dist/conformance/daytona.js";

const SETTINGS = { disk: "dsk-00000000000baf76", region: "aws-us-east-1", token: "tok-conformance-0123456789abcdef", apiKey: "key-0123", s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" };

function fakeS3() {
	const objects = new Map();
	const requests = [];
	const fetch = async (input, init = {}) => {
		const url = new URL(String(input));
		const method = init.method ?? "GET";
		requests.push({ method, url: url.href, auth: init.headers?.Authorization, redirect: init.redirect });
		const [, disk, ...rest] = url.pathname.split("/").map(decodeURIComponent);
		const key = rest.join("/");
		if (disk !== SETTINGS.disk) return new Response(null, { status: 404 });
		if (method === "GET" && url.searchParams.get("list-type") === "2") {
			const prefix = url.searchParams.get("prefix");
			const keys = [...objects.keys()].filter((k) => k.startsWith(prefix));
			return new Response(`<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("")}</ListBucketResult>`, { status: 200 });
		}
		if (method === "PUT") {
			objects.set(key, new Uint8Array(await new Response(init.body).arrayBuffer()));
			return new Response(null, { status: 200 });
		}
		if (method === "GET") return objects.has(key) ? new Response(objects.get(key), { status: 200 }) : new Response(null, { status: 404 });
		if (method === "DELETE") {
			objects.delete(key);
			return new Response(null, { status: 204 });
		}
		return new Response(null, { status: 405 });
	};
	return { fetch, objects, requests };
}

test("the settings are COMPUTER_ARCHIL_*, all five or none", () => {
	assert.deepEqual(Object.values(ARCHIL_ENV), ["COMPUTER_ARCHIL_DISK", "COMPUTER_ARCHIL_REGION", "COMPUTER_ARCHIL_TOKEN", "COMPUTER_ARCHIL_API_KEY", "COMPUTER_ARCHIL_S3_URL"]);
	assert.equal(archilSettingsFromEnv({}), undefined);
	const env = Object.fromEntries(Object.entries(ARCHIL_ENV).map(([field, name]) => [name, SETTINGS[field]]));
	assert.deepEqual(archilSettingsFromEnv(env), SETTINGS);
	assert.throws(() => archilSettingsFromEnv({ [ARCHIL_ENV.disk]: SETTINGS.disk }), /COMPUTER_ARCHIL_TOKEN/);
});

test("an endpoint that is not https on an Archil host of the region is refused before any request", async () => {
	for (const s3Url of ["http://s3.green.us-east-1.aws.prod.archil.com", "https://s3.example.com", "https://s3.green.eu-west-1.aws.prod.archil.com"]) {
		const s3 = fakeS3();
		await assert.rejects(archilFolder({ ...SETTINGS, s3Url, fetch: s3.fetch }), /Archil host for region aws-us-east-1/);
		assert.deepEqual(s3.requests, []);
	}
});

test("a folder: its markers made, files read and written by key with the account key, the run's folder cleared at close", async () => {
	const s3 = fakeS3();
	const folder = await archilFolder({ ...SETTINGS, fetch: s3.fetch });
	assert.match(folder.mount.folder, /^agents\/conformance\/runs\/c[0-9a-f]{12}\/work$/);
	assert.equal(folder.mount.folder, `agents/conformance/runs/${folder.run}/work`);
	assert.deepEqual({ ...folder.mount, folder: "" }, { kind: "archil", disk: SETTINGS.disk, region: SETTINGS.region, folder: "", token: SETTINGS.token });
	assert.ok(s3.objects.has(`${folder.mount.folder}/`), "the folder's marker");
	assert.equal(await folder.read("missing.txt"), undefined);
	await folder.write("a.txt", Buffer.from("hello"));
	assert.equal(Buffer.from(await folder.read("a.txt")).toString(), "hello");
	for (const request of s3.requests) {
		assert.equal(request.auth, `Bearer ${SETTINGS.apiKey}`);
		assert.equal(request.redirect, "error");
		assert.ok(!request.url.includes(SETTINGS.token), "the mount token never goes to the file API");
	}
	await folder.close();
	assert.deepEqual([...s3.objects.keys()].filter((key) => key.includes(folder.run)), []);
});

test("Daytona's conformance module gives an Archil folder when the settings are there, and none for a bind", async () => {
	assert.equal(await mountFor("bind", { env: {} }), undefined);
	assert.equal(await mountFor("archil", { env: {} }), undefined);
});

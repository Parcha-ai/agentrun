// The Archil run folder every remote provider's conformance module gives the mount cases (src/conformance/archil.ts):
// a fresh agents/<agent>/runs/<run>/work on a disk, reached from outside through the disk's object API, from the
// host's `disk` SDK or one given. Its settings are options, read from COMPUTER_ARCHIL_* by each module. No SDK is
// loaded and nothing reaches Archil here: the object API and the SDK's constructor are fakes.
import assert from "node:assert/strict";
import test from "node:test";
import { fakeObjects } from "./fake-modal.mjs";

const { ARCHIL_ENV, archilRunFolder, archilSettings } = await import("../dist/conformance/archil.js");

const TOKEN = "tok-conformance-archil-0123456789abcdef";
const KEY = "key-archil-account-0123456789abcdef";
const DISK = "dsk-00000000000baf76";
const REGION = "aws-us-east-1";
const S3 = "https://s3.green.us-east-1.aws.prod.archil.com";
const ENV = { COMPUTER_ARCHIL_DISK: DISK, COMPUTER_ARCHIL_REGION: REGION, COMPUTER_ARCHIL_TOKEN: TOKEN, COMPUTER_ARCHIL_API_KEY: KEY, COMPUTER_ARCHIL_S3_URL: S3 };
const FOLDER = /^agents\/conformance\/runs\/[A-Za-z0-9][A-Za-z0-9_-]*\/work$/;
const secretless = (value, what) => {
	const text = JSON.stringify(value ?? null);
	assert.ok(!text.includes(TOKEN) && !text.includes(KEY), `${what} holds a secret`);
};

test("ARCHIL_ENV names the settings a module reads for the Archil mount cases", () => {
	assert.deepEqual(ARCHIL_ENV, {
		archilDisk: "COMPUTER_ARCHIL_DISK",
		archilRegion: "COMPUTER_ARCHIL_REGION",
		archilToken: "COMPUTER_ARCHIL_TOKEN",
		archilApiKey: "COMPUTER_ARCHIL_API_KEY",
		archilS3Url: "COMPUTER_ARCHIL_S3_URL",
	});
});

test("archilSettings: all of them or none; a partial set, or an S3 endpoint the key must not go to, is refused in words that hold no value", () => {
	assert.equal(archilSettings({}), undefined, "no disk named: no Archil run folder");
	assert.deepEqual(archilSettings(ENV), { disk: DISK, region: REGION, token: TOKEN, apiKey: KEY, s3BaseUrl: S3 });
	assert.throws(
		() => archilSettings({ COMPUTER_ARCHIL_DISK: DISK, COMPUTER_ARCHIL_TOKEN: TOKEN }),
		(error) => /COMPUTER_ARCHIL_REGION/.test(error.message) && /COMPUTER_ARCHIL_API_KEY/.test(error.message) && !error.message.includes(TOKEN),
	);
	for (const s3 of ["http://s3.green.us-east-1.aws.prod.archil.com", "https://s3.example.com", "https://s3.green.eu-west-1.aws.prod.archil.com", "not a url"]) {
		assert.throws(() => archilSettings({ ...ENV, COMPUTER_ARCHIL_S3_URL: s3 }), (error) => /COMPUTER_ARCHIL_S3_URL/.test(error.message) && !error.message.includes(KEY), s3);
	}
	assert.throws(() => archilSettings({ ...ENV, COMPUTER_ARCHIL_DISK: "dsk;rm" }), /COMPUTER_ARCHIL_DISK/);
	assert.throws(() => archilSettings({ ...ENV, COMPUTER_ARCHIL_REGION: "us" }), /COMPUTER_ARCHIL_REGION/);
});

test("archilRunFolder over a given object API: a fresh folder of the helper's shape, read and written outside, a missing file undefined, close removes what the case touched", async () => {
	const objects = fakeObjects();
	const folder = await archilRunFolder({ disk: DISK, region: REGION, token: TOKEN, objects });
	assert.deepEqual({ ...folder.mount, folder: undefined }, { kind: "archil", disk: DISK, region: REGION, folder: undefined, token: TOKEN });
	assert.match(folder.mount.folder, FOLDER);
	const other = await archilRunFolder({ disk: DISK, region: REGION, token: TOKEN, objects });
	assert.notEqual(other.mount.folder, folder.mount.folder, "a fresh folder each time");
	await other.close();
	const named = await archilRunFolder({ disk: DISK, region: REGION, token: TOKEN, objects, agent: "a1", run: "r7" });
	assert.equal(named.mount.folder, "agents/a1/runs/r7/work");
	// The folder's run, which a computer that mounts it is labelled for (agentrun.run): the helper's rule.
	assert.equal(named.run, "r7");
	assert.equal(folder.run, folder.mount.folder.split("/")[3]);
	// The folder is there before any computer mounts it: its marker is the first thing written.
	const first = objects.calls.find(([name]) => name === "putObject");
	assert.deepEqual(first, ["putObject", `${folder.mount.folder}/`]);
	await named.close();
	await folder.write("a.txt", Buffer.from("outside\n"));
	assert.deepEqual(objects.calls.at(-1), ["putObject", `${folder.mount.folder}/a.txt`]);
	assert.equal(Buffer.from(await folder.read("a.txt")).toString("utf8"), "outside\n");
	assert.equal(await folder.read("missing.txt"), undefined);
	await assert.rejects(folder.read("broken.txt"), /unreachable/, "any other failure is thrown");
	await assert.rejects(folder.write("../escape.txt", Buffer.from("x")), /inside/);
	await assert.rejects(folder.read("/etc/passwd"), /inside/);
	await folder.close();
	assert.equal(objects.objects.size, 0);
	assert.ok(objects.calls.some(([name, key]) => name === "deleteObject" && key === `${folder.mount.folder}/missing.txt`), "what it read is removed too: the computer may have written it");
	secretless(objects.calls, "the object API's calls");
	await assert.rejects(archilRunFolder({ disk: DISK, region: REGION, token: TOKEN, objects, run: "../x" }), /run/);
});

test("archilRunFolder with no object API given: the SDK's Archil client, every setting passed explicitly, and the disk looked up once", async () => {
	const made = [];
	const objects = fakeObjects();
	class Archil {
		constructor(options) {
			made.push({ options, got: [] });
			this.disks = { get: async (id) => (made.at(-1).got.push(id), objects) };
		}
	}
	const folder = await archilRunFolder({ disk: DISK, region: REGION, token: TOKEN, apiKey: KEY, s3BaseUrl: S3, Archil });
	assert.deepEqual(made, [{ options: { apiKey: KEY, region: REGION, s3BaseUrl: S3 }, got: [DISK] }]);
	await folder.write("b.txt", Buffer.from("y"));
	assert.deepEqual(objects.calls, [["putObject", `${folder.mount.folder}/b.txt`]]);
	await assert.rejects(archilRunFolder({ disk: DISK, region: REGION, token: TOKEN, Archil }), (error) => /apiKey/.test(error.message) && !error.message.includes(TOKEN));
	const failing = class {
		constructor() {
			this.disks = { get: async () => Promise.reject(Object.assign(new Error(`401: bad key ${KEY}`), { status: 401 })) };
		}
	};
	await assert.rejects(archilRunFolder({ disk: DISK, region: REGION, token: TOKEN, apiKey: KEY, s3BaseUrl: S3, Archil: failing }), (error) => /401/.test(error.message) && !error.message.includes(KEY));
});

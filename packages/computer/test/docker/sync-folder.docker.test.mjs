// The synced folder's delta in a Docker computer (AGENTRUN_COMPUTER_LIVE_DOCKER=1 only): the cases of
// sync-folder-cases.mjs, each in a folder under /work, over the computer's own computerd. Needs `npm run build` and
// `npm run build:daemon` first, and debian:bookworm-slim pulled. The container is removed by its exact name in the after
// hook, pass or fail.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import "./teardown.mjs";
import { DockerProvider } from "../../dist/docker.js";
import { CASES, folderOf } from "../sync-folder-cases.mjs";
import { newRequest } from "./request.mjs";

const LIVE = process.env.AGENTRUN_COMPUTER_LIVE_DOCKER === "1";

describe("the synced folder's delta in a Docker computer", { skip: LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_DOCKER=1 to run on real Docker" }, () => {
	const made = [];
	let connection;

	before(async () => {
		const arch = execFileSync("docker", ["version", "--format", "{{.Server.Arch}}"], { encoding: "utf8" }).trim();
		const daemonPath = fileURLToPath(new URL(`../../dist/computerd-linux-${arch}`, import.meta.url));
		assert.ok(existsSync(daemonPath), `no daemon for Docker's arch at ${daemonPath}: run npm run build:daemon`);
		const provider = new DockerProvider({ env: process.env, daemonPath });
		const created = await provider.create({ image: "debian:bookworm-slim", lifetimeMs: 10 * 60_000, network: "none", labels: { "agentrun.test": "sync-folder" } }, newRequest("sync-folder"));
		assert.equal(created.ok, true, JSON.stringify(created));
		made.push(created.value.name);
		const connected = await provider.connect(created.value);
		assert.equal(connected.ok, true, JSON.stringify(connected));
		connection = connected.value;
	});

	after(async () => {
		await connection?.close();
		for (const name of made) {
			try {
				execFileSync("docker", ["rm", "--force", "--volumes", name], { stdio: "ignore" });
			} catch {
				// Already removed.
			}
		}
	});

	CASES.forEach(({ name, setup, run }, n) => {
		it(name, async () => run(await folderOf(connection.client, "/work/folders", `case-${n}`, setup)));
	});
});

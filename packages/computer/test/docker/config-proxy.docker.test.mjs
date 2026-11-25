// The host's docker config.json proxies never reach a computer, on real Docker (AGENTRUN_COMPUTER_LIVE_DOCKER=1 only).
// The docker CLI fills in each proxy variable a `docker run` does not set itself from config.json's `proxies`, so a
// computer made under a DOCKER_CONFIG that names one would hold it, and any credential in its URL with it. Here the
// provider runs under a DOCKER_CONFIG of this file's own whose config.json names a proxy, and the computer's
// environment, as Docker holds it, has every proxy variable empty. Needs `npm run build` and
// `npm run build:daemon` first, and alpine:3.20 pulled. The computer is removed by its exact name in the after hook.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import "./teardown.mjs";
import { DockerProvider } from "../../dist/docker.js";
import { newRequest } from "./request.mjs";

const LIVE = process.env.AGENTRUN_COMPUTER_LIVE_DOCKER === "1";
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" });
const PROXY = "http://proxy.invalid:3128";
const NAMES = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "FTP_PROXY", "ftp_proxy", "NO_PROXY", "no_proxy", "ALL_PROXY", "all_proxy"];

describe("a computer made under a docker config.json that names a proxy", { skip: LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_DOCKER=1 to run on real Docker" }, () => {
	const config = mkdtempSync(join(tmpdir(), "computer-config-proxy-"));
	const made = [];

	after(() => {
		for (const name of made) {
			try {
				execFileSync("docker", ["rm", "--force", "--volumes", name], { stdio: "ignore" });
			} catch {
				// Already removed.
			}
		}
		rmSync(config, { recursive: true, force: true });
	});

	it("holds every proxy variable empty: config.json's proxy never reaches it", async () => {
		const arch = docker("version", "--format", "{{.Server.Arch}}").trim();
		const daemonPath = fileURLToPath(new URL(`../../dist/computerd-linux-${arch}`, import.meta.url));
		assert.ok(existsSync(daemonPath), `no daemon for Docker's arch at ${daemonPath}: run npm run build:daemon`);
		const proxies = { httpProxy: PROXY, httpsProxy: PROXY, ftpProxy: PROXY, allProxy: PROXY, noProxy: "elsewhere.invalid" };
		writeFileSync(join(config, "config.json"), JSON.stringify({ proxies: { default: proxies } }));
		const provider = new DockerProvider({ env: { ...process.env, DOCKER_CONFIG: config }, daemonPath });
		const created = await provider.create({ image: "alpine:3.20", lifetimeMs: 5 * 60_000, network: "none" }, newRequest("config-proxy"));
		assert.equal(created.ok, true, JSON.stringify(created));
		made.push(created.value.name);
		const env = JSON.parse(docker("inspect", "--type", "container", "--format", "{{json .Config.Env}}", created.value.name));
		const held = Object.fromEntries(env.map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]).filter(([name]) => NAMES.includes(name)));
		assert.deepEqual(held, Object.fromEntries(NAMES.map((name) => [name, ""])), `the computer holds config.json's proxy: ${JSON.stringify(held)}`);
	});
});

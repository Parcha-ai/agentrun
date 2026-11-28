// An idle HTTP/2 session in undici must not end the process. The Archil disk SDK builds its undici Agent with
// allowH2 and no way to turn it off, and the E2B SDK's fetch uses the same undici; serve loads both. A request aborted
// on an established session left a stream that the session's idle timeout then destroyed with an error and no
// listener: "Unhandled 'error' event ... InformationalError: socket idle timeout" on a ClientHttp2Stream, and the
// process ended. Each case runs in its own child, against a local HTTP/2 server with a throwaway self-signed
// certificate, with the undici that serve, the disk SDK and the E2B SDK each resolve.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const CHILD = fileURLToPath(new URL("./fixtures/undici-h2-idle-child.mjs", import.meta.url));
const UNDICI = {
	serve: require.resolve("undici"),
	disk: createRequire(require.resolve("disk")).resolve("undici"),
	e2b: createRequire(createRequire(new URL("../../computer/package.json", import.meta.url)).resolve("e2b")).resolve("undici"),
};

/** A self-signed key and certificate in a fresh directory, or undefined when the openssl CLI can't make one. */
function certificate(t) {
	const dir = mkdtempSync(join(tmpdir(), "undici-h2-idle-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const key = join(dir, "key.pem");
	const cert = join(dir, "cert.pem");
	const made = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
	return made.status === 0 ? { key, cert } : undefined;
}

function runChild(undiciPath, shape, { key, cert }) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [CHILD, undiciPath, shape, key, cert], { stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", reject);
		child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
	});
}

for (const [owner, undiciPath] of Object.entries(UNDICI)) {
	for (const shape of ["fetch", "request"]) {
		test(`the undici ${owner} resolves: a ${shape} aborted on an established HTTP/2 session, then the session's idle timeout, leaves the process running`, async (t) => {
			const pem = certificate(t);
			if (pem === undefined) return t.skip("the openssl CLI could not make a self-signed certificate");
			const { code, signal, stdout, stderr } = await runChild(undiciPath, shape, pem);
			assert.doesNotMatch(stderr, /Unhandled 'error'|socket idle timeout|UND_ERR_INFO/, stderr);
			assert.match(stdout, /^aborted AbortError$/m, stdout);
			assert.match(stdout, /^survived$/m, stdout);
			assert.deepEqual({ code, signal }, { code: 0, signal: null }, stderr);
		});
	}
}

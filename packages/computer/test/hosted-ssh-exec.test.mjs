// The shared SSH exec (src/hosted/ssh-exec.ts): the login is the host's, and no error carries its secrets. Its
// connections, channels and kills are tested through Agent37's host, against a real sshd (agent37-provider.test.mjs).
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

const { SshExec } = await import("../dist/hosted/ssh-exec.js");
const { redact } = await import("../dist/hosted/process.js");

const SECRET = "not-a-secret-api-key";
const KEY = "fake-test-key";

/** An ssh2 whose every handshake fails in words that echo the login, as ssh2's can echo the username. */
function echoingSsh2(logins) {
	return {
		Client: class extends EventEmitter {
			connect(config) {
				logins.push(config);
				setImmediate(() => this.emit("error", Object.assign(new Error(`authentication as ${config.username} with ${config.privateKey ?? config.password} failed`), { level: "client-authentication" })));
			}
			end() {}
			destroy() {}
		},
	};
}

const tunnelOf = () => ({ duplex: new PassThrough(), opened: Promise.resolve(), host: "m1.ssh.example.test" });

test("an SshExec logs in as the host gives (a username carrying a key, Morph's), and the failed connect's error has every secret redacted, its class and fields kept", async () => {
	const logins = [];
	const ssh = new SshExec({ ssh2: echoingSsh2(logins), loginOf: (id) => ({ username: `${id}:${SECRET}`, privateKey: KEY, secrets: [SECRET] }), tunnelOf });
	const error = await ssh.exec("m1", ["true"], { timeoutMs: 2_000 }).then(
		() => assert.fail("the exec answered"),
		(thrown) => thrown,
	);
	assert.equal(logins[0].username, `m1:${SECRET}`, "the host's username, by the machine's id");
	assert.equal(logins[0].privateKey, KEY);
	assert.equal(error.message, "authentication as m1:[redacted] with [redacted] failed");
	assert.doesNotMatch(error.stack, new RegExp(`${SECRET}|${KEY}`));
	assert.equal(error.level, "client-authentication", "the error is ssh2's own, its fields kept");
	// A password login: the password never shows either.
	const password = new SshExec({ ssh2: echoingSsh2([]), loginOf: () => ({ username: "root", password: SECRET }), tunnelOf });
	await assert.rejects(password.exec("m2", ["true"], { timeoutMs: 2_000 }), { message: "authentication as root with [redacted] failed" });
});

test("redact takes every secret out of words, the longest first, and skips an empty or missing one", () => {
	assert.equal(redact(`key ${SECRET} and ${SECRET}-2`, [SECRET, `${SECRET}-2`, "", undefined]), "key [redacted] and [redacted]");
	assert.equal(redact("nothing secret", []), "nothing secret");
});

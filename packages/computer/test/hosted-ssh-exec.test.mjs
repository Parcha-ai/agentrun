// The shared SSH exec (src/hosted/ssh-exec.ts): the login is the host's, and no error carries its secrets. Its
// connections, channels and kills are tested through Agent37's host, against a real sshd (agent37-provider.test.mjs).
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import ssh2 from "ssh2";

const { SshExec, pemOf } = await import("../dist/hosted/ssh-exec.js");
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

/** PEM armor around body, built so no BEGIN line of a private key is a literal (export-source.mjs blocks one). */
const armor = (label, body) => `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;

test("pemOf turns a PKCS#8 key, which ssh2 does not read, into the same key in a form it does: RSA as PKCS#1, EC as SEC1, Ed25519 as OpenSSH's", () => {
	const data = Buffer.from("signed by the converted key, checked with the original's public key");
	for (const [type, label, sshType, hash] of [
		["rsa", "RSA PRIVATE KEY", "ssh-rsa", "sha256"],
		["ec", "EC PRIVATE KEY", "ecdsa-sha2-nistp256", "sha256"],
		["ed25519", "OPENSSH PRIVATE KEY", "ssh-ed25519", null],
	]) {
		const { privateKey, publicKey } = generateKeyPairSync(type, { modulusLength: 2048, namedCurve: "P-256" });
		const pkcs8 = privateKey.export({ type: "pkcs8", format: "pem" });
		assert.match(ssh2.utils.parseKey(pkcs8).message, /Unsupported key format/, `${type}: ssh2 reads no PKCS#8`);
		for (const given of [pkcs8, pkcs8.replace(/\n/g, " "), pkcs8.replace(/\n/g, "\r\n")]) {
			const pem = pemOf(given);
			// assert.ok, not match or equal: a failure never prints a key, even a throwaway one.
			assert.ok(new RegExp(`^-----BEGIN ${label}-----\\n(?:[A-Za-z0-9+/=]{1,70}\\n)+-----END ${label}-----\\n$`).test(pem ?? ""), `${type}: ${label}, wrapped at 70`);
			const parsed = ssh2.utils.parseKey(pem);
			assert.ok(!(parsed instanceof Error), `${type}: ${parsed.message}`);
			assert.equal(parsed.type, sshType);
			assert.equal(verify(hash, data, publicKey, parsed.sign(data, hash ?? undefined)), true, `${type}: the same key`);
		}
	}
	const x25519 = generateKeyPairSync("x25519").privateKey.export({ type: "pkcs8", format: "pem" });
	assert.equal(pemOf(x25519), undefined, "a PKCS#8 key of a type SSH has no use for is no key");
	assert.equal(pemOf(armor("PRIVATE KEY", "AAAA")), undefined, "a body node:crypto can't read is no key");
});

test("pemOf hands a key ssh2 reads back as it is, its body wrapped at 70 characters", () => {
	const openssh = ssh2.utils.generateKeyPairSync("ed25519").private;
	assert.ok(pemOf(openssh.replace(/\n/g, " ")) === pemOf(openssh), "one line or many, the same key");
	assert.equal(ssh2.utils.parseKey(pemOf(openssh)).type, "ssh-ed25519");
	const pkcs1 = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
	assert.ok(pemOf(pkcs1)?.replace(/\n/g, "") === pkcs1.replace(/\n/g, ""), "PKCS#1 is not converted");
});

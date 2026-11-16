// Computerd's signing scripts (daemon-macos/scripts/notarize.sh and bundle.sh's keychain setting), run on Linux against
// fake xcrun, ditto, spctl, swift and codesign on PATH. Each fake writes its argv to a log, one call a line, so a test
// reads exactly what the script asked of Apple's tools.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPTS = fileURLToPath(new URL("../daemon-macos/scripts/", import.meta.url));

// Every fake logs its name and arguments, tab-separated, then acts on FAKE_STATUS where it matters.
const LOG_ARGV = `{ printf '%s' "$(basename "$0")"; printf '\\t%s' "$@"; printf '\\n'; } >>"$FAKE_LOG"\n`;
const FAKES = {
	xcrun: `case "$1 $2" in
"notarytool submit") printf '{"id":"0f1e2d3c-fake-submission","message":"Processing complete","status":"%s"}\\n' "$FAKE_STATUS" ;;
"notarytool log") echo "fake notary log: The signature of the binary is invalid." ;;
"stapler staple") echo "The staple and validate action worked!" ;;
"stapler validate") echo "The validate action worked!" ;;
*) echo "fake xcrun: unexpected $*" >&2; exit 64 ;;
esac`,
	ditto: `[ "$1 $2 $3" = "-c -k --keepParent" ] || { echo "fake ditto: unexpected $*" >&2; exit 64; }
printf 'zip of %s\\n' "$(basename "$4")" >"$5"`,
	spctl: `echo "$4: accepted"; echo "source=Notarized Developer ID"`,
	swift: `case "$*" in
*--show-bin-path*) echo "$FAKE_BIN" ;;
*) mkdir -p "$FAKE_BIN"; touch "$FAKE_BIN/ComputerdApp" "$FAKE_BIN/computerd" ;;
esac`,
	codesign: `case "$1" in --display) echo "designated => identifier ai.parcha.computerd" ;; esac`,
};

// The keys a signing run holds. None of them may reach a tool's argv: notarize.sh names only the profile.
const SECRETS = Object.fromEntries([
	["APPLE_NOTARY_KEY_P8", "not-a-secret-notary-p8-body"],
	["APPLE_NOTARY_KEY_ID", "not-a-secret-key-id"],
	["APPLE_NOTARY_ISSUER_ID", "not-a-secret-issuer-id"],
	["APPLE_DEVELOPER_ID_P12", "not-a-secret-p12-base64"],
	["APPLE_DEVELOPER_ID_P12_PASSWORD", "not-a-secret-p12-password"],
]);

function scratch(t) {
	const dir = mkdtempSync(join(tmpdir(), "computerd-sign-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const fakes = join(dir, "fakes");
	mkdirSync(fakes);
	for (const [name, body] of Object.entries(FAKES)) {
		writeFileSync(join(fakes, name), `#!/usr/bin/env bash\n${LOG_ARGV}${body}\n`);
		chmodSync(join(fakes, name), 0o755);
	}
	return { dir, fakes, log: join(dir, "argv.log") };
}

/** The calls the fakes logged, each as [tool, ...args]. */
function calls(log) {
	let text = "";
	try {
		text = readFileSync(log, "utf8");
	} catch {}
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split("\t"));
}

function run(s, script, args, env) {
	return spawnSync("bash", [join(SCRIPTS, script), ...args], {
		encoding: "utf8",
		env: { PATH: `${s.fakes}:${process.env.PATH}`, HOME: s.dir, TMPDIR: s.dir, FAKE_LOG: s.log, ...SECRETS, ...env },
	});
}

function notarize(t, status, env = {}) {
	const s = scratch(t);
	const app = join(s.dir, "build", "Computerd.app");
	mkdirSync(join(app, "Contents"), { recursive: true });
	const r = run(s, "notarize.sh", [app], { FAKE_STATUS: status, COMPUTERD_NOTARY_PROFILE: "computerd-notary", ...env });
	return { ...s, app, r, calls: calls(s.log) };
}

test("an Accepted submission is stapled, validated, assessed and zipped, with its sha256 printed", (t) => {
	const { r, app, calls: c, dir } = notarize(t, "Accepted", { COMPUTERD_NOTARY_KEYCHAIN: "/tmp/sign.keychain-db" });
	assert.equal(r.status, 0, r.stderr);
	const tools = c.map((call) => call.slice(0, 3).join(" "));
	assert.deepEqual(tools, [
		"ditto -c -k",
		"xcrun notarytool submit",
		"xcrun stapler staple",
		"xcrun stapler validate",
		"spctl -a -t",
		"ditto -c -k",
	]);
	const submit = c[1];
	assert.ok(submit.includes("--wait"));
	assert.equal(submit[submit.indexOf("--keychain-profile") + 1], "computerd-notary");
	assert.equal(submit[submit.indexOf("--keychain") + 1], "/tmp/sign.keychain-db");
	assert.deepEqual(c[2].slice(3), [app]);
	assert.deepEqual(c[3].slice(3), [app]);
	assert.deepEqual(c[4].slice(1), ["-a", "-t", "exec", "-vv", app]);
	const zip = join(dir, "build", "Computerd.zip");
	assert.deepEqual(c[5].slice(4), [app, zip]);
	assert.equal(readFileSync(zip, "utf8"), "zip of Computerd.app\n");
	assert.match(r.stdout, /accepted submission 0f1e2d3c-fake-submission/);
	assert.match(r.stdout, new RegExp(`^[0-9a-f]{64}  ${zip}$`, "m"));
});

test("an Invalid submission fetches the notary log and fails in words, with nothing stapled", (t) => {
	const { r, calls: c, dir } = notarize(t, "Invalid");
	assert.equal(r.status, 1);
	assert.match(r.stderr, /Apple did not accept .*status "Invalid"/);
	assert.match(r.stderr, /fake notary log: The signature of the binary is invalid\./);
	const tools = c.map((call) => call.slice(0, 3).join(" "));
	assert.deepEqual(tools, ["ditto -c -k", "xcrun notarytool submit", "xcrun notarytool log"]);
	const log = c[2];
	assert.equal(log[3], "0f1e2d3c-fake-submission");
	assert.equal(log[log.indexOf("--keychain-profile") + 1], "computerd-notary");
	assert.ok(!log.includes("--keychain"), "no keychain was set");
	assert.throws(() => readFileSync(join(dir, "build", "Computerd.zip")));
});

test("no key reaches a tool's argv: notarytool gets the profile name and no key, id or issuer", (t) => {
	for (const status of ["Accepted", "Invalid"]) {
		const { calls: c } = notarize(t, status);
		assert.ok(
			c.some((call) => call[1] === "notarytool" && call[2] === "submit"),
			"notarize.sh submitted",
		);
		for (const call of c) {
			for (const [name, value] of Object.entries(SECRETS)) assert.ok(!call.some((a) => a.includes(value)), `${name} in ${call.join(" ")}`);
			if (call[1] !== "notarytool") continue;
			for (const flag of ["--key", "--key-id", "--issuer", "--apple-id", "--password", "--team-id"]) {
				assert.ok(!call.includes(flag), `${flag} in ${call.join(" ")}`);
			}
		}
	}
});

test("bundle.sh signs from COMPUTERD_SIGN_KEYCHAIN alone when it is set, and from the search list when not", (t) => {
	for (const keychain of ["/tmp/sign.keychain-db", undefined]) {
		const s = scratch(t);
		const env = { FAKE_BIN: join(s.dir, "bin"), COMPUTERD_SIGN_IDENTITY: "Developer ID Application: Fake (FAKETEAM01)" };
		if (keychain) env.COMPUTERD_SIGN_KEYCHAIN = keychain;
		const r = run(s, "bundle.sh", [join(s.dir, "out")], env);
		assert.equal(r.status, 0, r.stderr);
		const signs = calls(s.log).filter((call) => call[0] === "codesign" && call.includes("--sign"));
		assert.equal(signs.length, 2, "the helper, then the app");
		for (const sign of signs) {
			assert.ok(sign.includes("--options") && sign.includes("--timestamp"));
			if (keychain) assert.equal(sign[sign.indexOf("--keychain") + 1], keychain);
			else assert.ok(!sign.includes("--keychain"));
		}
	}
});

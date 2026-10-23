// The launcher's pure spec check (`launchSpecError`, `@parcha/pi-transport/launch`): what `launch` refuses about a spec, known
// before any box exists. A host that makes a box only to launch in it (disk's boxHost, a VM) asks it first, so a bad spec never
// boots a machine. `launch` calls the same function first: one answer, never two checks that can drift.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import type { Box } from "../src/box/box.ts";
import { type LaunchSpec, launch, launchSpecError } from "../src/launch/index.ts";

const context = BACKGROUND_CONTEXT;
const VALUE = "zz-a-value-never-echoed-zz";

/** A box that records every property it is asked for: a pure check asks it nothing. */
function recordingBox(): { box: Box; touched: string[] } {
	const touched: string[] = [];
	const box = new Proxy({} as Box, {
		get(_target, key) {
			touched.push(String(key));
			return key === "facts" ? () => ({ secretsVia: "fd", liveProcesses: true }) : undefined;
		},
	});
	return { box, touched };
}

const refused: [string, LaunchSpec][] = [
	["a launcher name in env", { argv: ["true"], env: { FSEC: VALUE } }],
	["a launcher temporary in env", { argv: ["true"], env: { line: VALUE } }],
	["a loader name in env", { argv: ["true"], env: { LD_PRELOAD: VALUE } }],
	["any LD_ name in env", { argv: ["true"], env: { LD_DEBUG: VALUE } }],
	["a shell name in env", { argv: ["true"], env: { BASH_ENV: VALUE } }],
	["a key-shaped name in env", { argv: ["true"], env: { MODAL_TOKEN_ID: VALUE } }],
	["a name the launcher sets", { argv: ["true"], env: { PATH: VALUE } }],
	["a name that is not a name", { argv: ["true"], env: { "not a name": VALUE } }],
	["a launcher name in inheritEnv", { argv: ["true"], inheritEnv: ["FIN"] }],
	["a loader name in inheritEnv", { argv: ["true"], inheritEnv: ["LD_AUDIT"] }],
	["a name both in env and inheritEnv", { argv: ["true"], env: { APP: VALUE }, inheritEnv: ["APP"] }],
	["a bad user", { argv: ["true"], user: "not a user!" }],
	["an empty argv", { argv: [] }],
	["a secret that is not a name", { argv: ["true"], secrets: { "not a name": VALUE } }],
	["stdin over 64 KiB", { argv: ["true"], stdin: new Uint8Array(64 * 1024 + 1) }],
	["a framed launch as root", { argv: ["true"], user: "root", stdin: new Uint8Array([1]) }],
	["a framed launch as uid 0", { argv: ["true"], user: "0", secrets: { A: VALUE } }],
	["a tools user that is not a user name or uid", { argv: ["true"], toolsUser: "not a user!" }],
	["root as the tools user", { argv: ["true"], toolsUser: "root", stdin: new Uint8Array([1]) }],
	["uid 0 as the tools user", { argv: ["true"], toolsUser: "00" }],
	["a tools user beside a program run as another user", { argv: ["true"], user: "pda", toolsUser: "pdb" }],
	["the tools user's name in env", { argv: ["true"], env: { PI_TRANSPORT_TOOLS_USER: VALUE } }],
	["the tools user's uid in env", { argv: ["true"], env: { PI_TRANSPORT_TOOLS_UID: VALUE } }],
];

describe("launchSpecError", () => {
	it("gives, for every refusal launch gives on a spec, the SAME code and message, touches no box, and never echoes the value", async () => {
		for (const [what, spec] of refused) {
			const pure = launchSpecError("named", spec);
			expect(pure?.code, what).toBe("invalid");
			const { box, touched } = recordingBox();
			const launched = await launch(box, "named", spec, context);
			expect(launched.ok, what).toBe(false);
			if (launched.ok) continue;
			expect(launched.error.code, what).toBe(pure!.code);
			expect(launched.error.message, what).toBe(pure!.message);
			expect(touched, `${what}: launch asked the box nothing`).toEqual([]);
			expect(pure!.message, what).not.toContain(VALUE);
		}
		expect(launchSpecError("not a name!", { argv: ["true"] })?.code).toBe("invalid");
	});

	it("passes a good spec, as launch would", () => {
		expect(
			launchSpecError("named", {
				argv: ["sleep", "300"],
				env: { MODE_OF_APP: "home", PDA_HOLDER: "{}" },
				user: "pda",
				stdin: new Uint8Array([1]),
			}),
		).toBeUndefined();
	});
});

describe("the README's launch example", () => {
	it("passes the spec check: its settings use no name the launcher reserves", async () => {
		const { readFileSync } = await import("node:fs");
		const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
		const line = readme.split("\n").find((each) => each.includes('await launch(box, "runner"'));
		expect(line).toBeDefined();
		const env = Object.fromEntries([...line!.matchAll(/([A-Z_][A-Z0-9_]*): "([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));
		expect(Object.keys(env).length).toBeGreaterThan(0);
		expect(launchSpecError("runner", { argv: ["node", "runner.js"], env })).toBeUndefined();
	});
});

describe("a framed launch's user", () => {
	const ROOT = "a launch with stdin or secrets runs its program as root (uid 0) only with a toolsUser";
	const stdin = new Uint8Array([1]);

	it("runs as root only with a toolsUser: root or uid 0 without one is refused, with one accepted; a non-framed launch may name root", () => {
		expect(launchSpecError("named", { argv: ["true"], user: "root" })).toBeUndefined();
		for (const user of ["root", "0", "00"]) {
			const refusal = launchSpecError("named", { argv: ["true"], user, stdin });
			expect(refusal?.code, user).toBe("invalid");
			expect(refusal?.message.startsWith(ROOT), refusal?.message).toBe(true);
			expect(launchSpecError("named", { argv: ["true"], user, stdin, toolsUser: "pda" }), user).toBeUndefined();
		}
		// No user: the program runs as the launcher, which must be root for a toolsUser (the launcher checks it in the box).
		expect(launchSpecError("named", { argv: ["true"], stdin, toolsUser: "pda" })).toBeUndefined();
		expect(launchSpecError("named", { argv: ["true"], stdin, toolsUser: "1000" })).toBeUndefined();
	});

	it("names its tools user as a user is named, never root, and only beside a program run as root", () => {
		const said = (spec: LaunchSpec) => launchSpecError("named", spec)?.message ?? "";
		expect(said({ argv: ["true"], toolsUser: "root" })).toMatch(/^the tools user root is root \(uid 0\)/);
		expect(said({ argv: ["true"], toolsUser: "0" })).toMatch(/^the tools user 0 is root \(uid 0\)/);
		expect(said({ argv: ["true"], user: "pda", toolsUser: "pdb", stdin })).toMatch(
			/^toolsUser goes only with a program run as root/,
		);
		expect(said({ argv: ["true"], toolsUser: "a b" })).toMatch(/^toolsUser is a user name or a numeric uid/);
	});
});

describe("a key-shaped name in env", () => {
	const keyed = (name: string) => launchSpecError("named", { argv: ["true"], env: { [name]: VALUE } });

	it.each(["KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "CREDENTIAL", "CREDENTIALS"])(
		"is refused for the segment %s, wherever it stands in the name and in any case, naming the name and never its value",
		(segment) => {
			for (const name of [segment, `APP_${segment}`, `${segment}_ID`, `MY_${segment.toLowerCase()}_FILE`]) {
				const refusal = keyed(name);
				expect(refusal?.code, name).toBe("invalid");
				expect(refusal?.message, name).toContain(`the environment name ${name} looks like a key`);
				expect(refusal?.message, name).not.toContain(VALUE);
			}
		},
	);

	it("is not a name with such a word inside a segment: MONKEY, TOKENS, KEYBOARD, SECRETARY and PASSWORDS pass", () => {
		for (const name of ["MONKEY", "TOKENS", "KEYBOARD", "SECRETARY", "PASSWORDS", "APP_TOKENS", "DONKEY_KONG"])
			expect(keyed(name), name).toBeUndefined();
	});
});

describe("the C library's tunables and locale path", () => {
	it("are refused as a program setting and as an inherited name: they would act on the root launcher's switch to the user", () => {
		for (const name of ["GLIBC_TUNABLES", "LOCPATH"]) {
			const set = launchSpecError("named", { argv: ["true"], user: "pda", env: { [name]: VALUE } });
			expect(set?.message, `env ${name}`).toBe(`the environment name ${name} is reserved by the launcher`);
			const inherited = launchSpecError("named", { argv: ["true"], user: "pda", inheritEnv: [name] });
			expect(inherited?.code, `inheritEnv ${name}`).toBe("invalid");
		}
	});
});

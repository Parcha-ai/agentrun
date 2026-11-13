// Every way scripts/check-env.mjs must find a read of the environment in library source. Each line that reaches it ends
// in a comment of one word, the marker the test looks for; no other line has that comment. Never compiled.
import nodeProcess from "node:process"; // caught
import { env as importedEnv } from "process"; // caught
const required = require("node:process"); // caught

export function evasions(): unknown[] {
	const plain = process.env.HOME; // caught
	const whole = process.env; // caught
	const bracketed = process["env"]; // caught
	const bracketedName = process.env["HOME"]; // caught
	const templated = process[`env`]; // caught
	const { env } = process; // caught
	const { env: renamed } = process; // caught
	const alias = process; // caught
	const viaGlobal = globalThis.process.env; // caught
	const viaGlobalBracket = globalThis["process"].env; // caught
	const viaNodeGlobal = global.process.env.HOME; // caught
	const computed = process["e" + "nv"]; // caught
	const parenthesized = (process).env.HOME; // caught
	const asserted = (process as NodeJS.Process).env; // caught
	const optional = process?.env?.HOME; // caught
	const keys = Object.keys(process); // caught
	const reflected = Reflect.get(process, "env"); // caught
	const dynamic = import("node:process"); // caught
	const globalAlias = globalThis; // caught
	const { process: destructured } = globalThis; // caught
	return [nodeProcess, importedEnv, required, plain, whole, bracketed, bracketedName, templated, env, renamed, alias, viaGlobal, viaGlobalBracket, viaNodeGlobal, computed, parenthesized, asserted, optional, keys, reflected, dynamic, globalAlias, destructured];
}

export function shadowed(process: { env: unknown }): unknown { // caught
	return process.env; // caught
}

// Checks dist/phoned.jar where it is built (the phoned CI job, and the release after its build:phoned): it is there,
// a jar whose first entry is classes.dex, deflated, as d8 writes it, and the dex is stamped with this package's
// version, the one phoned's hello reports. One sentence and exit 1 when it is not. The path is the first argument,
// default dist/phoned.jar beside this script's package.
//   node scripts/check-phoned-jar.mjs [jar]
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const jar = process.argv[2] ?? join(pkg, "dist", "phoned.jar");
const { version } = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
const named = relative(process.cwd(), jar) || jar;

/** Stops with one sentence on stderr. */
function fail(words) {
	console.error(`check-phoned-jar: ${words}`);
	process.exit(1);
}

if (!existsSync(jar)) fail(`${named} is missing: run npm run build:phoned -w @parcha/agentrun-computer (a JDK 17 and the Android SDK) after the build.`);
const bytes = readFileSync(jar);
// The first local file header: its signature, its method (8, deflated), its name, then its data.
const isZip = bytes.length > 30 && bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
const nameLength = isZip ? bytes.readUInt16LE(26) : 0;
if (!isZip || bytes.subarray(30, 30 + nameLength).toString() !== "classes.dex" || bytes.readUInt16LE(8) !== 8) {
	fail(`${named} is not a jar whose first entry is classes.dex, deflated: build it again with npm run build:phoned.`);
}
let dex;
try {
	dex = inflateRawSync(bytes.subarray(30 + nameLength + bytes.readUInt16LE(28)));
} catch (error) {
	fail(`${named}'s classes.dex does not inflate (${error.message}): build it again with npm run build:phoned.`);
}
if (dex.subarray(0, 4).toString("latin1") !== "dex\n") fail(`${named}'s classes.dex is not a dex file: build it again with npm run build:phoned.`);
if (!dex.includes(Buffer.from(version))) fail(`${named} is not stamped with ${version}, this package's version: run npm run build:phoned again after the version changes.`);
console.log(`check-phoned-jar: ${named} is phoned's dex jar, stamped ${version}.`);

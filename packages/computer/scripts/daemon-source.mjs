// Where the daemon binaries come from. `npm run build:daemon` builds them with Go when Go is on PATH and records which
// source they came from in dist/computerd.json. Without Go, it takes them from this version's published package on npm,
// but only when that package's record names the same daemon source as this checkout, so a binary is never older or
// newer than the code beside it. verify-packages (scripts/verify-packages.mjs) holds the release to the same record.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

export const ARCHES = ["amd64", "arm64"];
export const PACKAGE = "@parcha/agentrun-computer";
/** The record beside the binaries in dist: the package version they are stamped with and the source they were built from. */
export const RECORD = "computerd.json";

function sourceFiles(dir, root = dir) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			// Go leaves testdata out of every build.
			if (entry.name !== "testdata") files.push(...sourceFiles(path, root));
		} else if (entry.isFile() && !entry.name.endsWith("_test.go")) {
			files.push(relative(root, path).split(sep).join("/"));
		}
	}
	return files;
}

/** The daemon's source as one digest: every file Go builds from (tests left out), by path and content. */
export function sourceDigest(daemonDir) {
	const hash = createHash("sha256");
	for (const file of sourceFiles(daemonDir).sort()) {
		const bytes = readFileSync(join(daemonDir, file));
		hash.update(`${file}\0${bytes.length}\0`);
		hash.update(bytes);
	}
	return `sha256:${hash.digest("hex")}`;
}

export function writeRecord(dist, version, source) {
	writeFileSync(join(dist, RECORD), `${JSON.stringify({ version, source }, null, 2)}\n`);
}

/**
 * The binaries of an unpacked package (its package/ directory) copied into dist, when its record is this version built
 * from this source; otherwise an error that says why and what to do instead.
 */
export function adoptPublished({ packageDir, version, source, dist }) {
	const instead = "install Go 1.24 or newer (https://go.dev/dl/) and run npm run build:daemon again to build them from this checkout";
	const recordPath = join(packageDir, "dist", RECORD);
	if (!existsSync(recordPath)) throw new Error(`${PACKAGE}@${version} on npm carries no ${RECORD}, so which daemon source it was built from is unknown: ${instead}`);
	const record = JSON.parse(readFileSync(recordPath, "utf8"));
	if (record.version !== version) throw new Error(`${PACKAGE}@${version} on npm records version ${record.version}: ${instead}`);
	if (record.source !== source) {
		throw new Error(`the daemon source in this checkout (${source}) is not what ${PACKAGE}@${version} on npm was built from (${record.source}): ${instead}`);
	}
	mkdirSync(dist, { recursive: true });
	for (const arch of ARCHES) {
		const from = join(packageDir, "dist", `computerd-linux-${arch}`);
		if (!existsSync(from)) throw new Error(`${PACKAGE}@${version} on npm lacks dist/computerd-linux-${arch}: ${instead}`);
		const out = join(dist, `computerd-linux-${arch}`);
		copyFileSync(from, out);
		chmodSync(out, 0o755);
	}
	writeRecord(dist, version, source);
}

/**
 * This version's package from the registry, by npm pack (which checks the archive against the registry's integrity),
 * unpacked into a temporary directory; its package/ directory and a cleanup.
 */
export function fetchPublished(version, { npm = "npm" } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "computerd-npm-"));
	const cleanup = () => rmSync(dir, { recursive: true, force: true });
	try {
		let packed;
		try {
			packed = JSON.parse(execFileSync(npm, ["pack", `${PACKAGE}@${version}`, "--json", "--pack-destination", dir], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
		} catch (error) {
			const why = String(error.stderr ?? error.message).trim().split("\n").slice(-3).join(" ");
			throw new Error(`${PACKAGE}@${version} could not be fetched from npm (${why}): install Go 1.24 or newer (https://go.dev/dl/) to build the daemon instead`);
		}
		execFileSync("tar", ["-xzf", join(dir, packed[0].filename), "-C", dir]);
		return { packageDir: join(dir, "package"), cleanup };
	} catch (error) {
		cleanup();
		throw error;
	}
}

// `npm run build:daemon`: the daemon as static binaries for Linux, dist/computerd-linux-amd64 and dist/computerd-linux-arm64,
// stamped with this package's version, and dist/computerd.json, the source they came from. With Go on PATH it builds them.
// Without Go it takes them from this version's package on npm, when that package was built from this checkout's daemon
// source (daemon-source.mjs), and says what to do when it was not.
import { execFileSync } from "node:child_process";
import { accessSync, chmodSync, constants, mkdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ARCHES, adoptPublished, fetchPublished, PACKAGE, sourceDigest, writeRecord } from "./daemon-source.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const dist = join(root, "dist");
const source = sourceDigest(join(root, "daemon"));

function findOnPath(name) {
	for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
		const candidate = join(dir, name);
		try {
			if (statSync(candidate).isFile()) {
				accessSync(candidate, constants.X_OK);
				return candidate;
			}
		} catch {
			// Not in this directory.
		}
	}
	return undefined;
}

const go = findOnPath("go");
if (go === undefined) {
	console.log(`build:daemon: go was not found on PATH; taking the daemon from ${PACKAGE}@${version} on npm`);
	let fetched;
	let failed;
	try {
		fetched = fetchPublished(version);
		adoptPublished({ packageDir: fetched.packageDir, version, source, dist });
	} catch (error) {
		failed = error;
	} finally {
		fetched?.cleanup();
	}
	if (failed !== undefined) {
		console.error(`build:daemon: ${failed.message}`);
		process.exit(1);
	}
	for (const arch of ARCHES) console.log(`build:daemon: ${join(dist, `computerd-linux-${arch}`)} (${version}, from npm, ${source})`);
	process.exit(0);
}
mkdirSync(dist, { recursive: true });
for (const arch of ARCHES) {
	const out = join(dist, `computerd-linux-${arch}`);
	execFileSync(go, ["build", "-trimpath", "-ldflags", `-s -w -X main.version=${version}`, "-o", out, "./cmd/computerd"], {
		cwd: join(root, "daemon"),
		env: { ...process.env, CGO_ENABLED: "0", GOOS: "linux", GOARCH: arch },
		stdio: "inherit",
	});
	// Every computer drops every capability, so its root runs the mounted binary only if everyone may.
	chmodSync(out, 0o755);
	console.log(`build:daemon: ${out} (${statSync(out).size} bytes, ${version})`);
}
writeRecord(dist, version, source);

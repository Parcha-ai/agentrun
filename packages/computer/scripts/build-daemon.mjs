// `npm run build:daemon`: the daemon as static binaries for Linux, dist/computerd-linux-amd64 and dist/computerd-linux-arm64,
// stamped with this package's version. Needs Go on PATH.
import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

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
	console.error("build:daemon: go was not found on PATH; install Go 1.24 or newer (https://go.dev/dl/) and run it again");
	process.exit(1);
}
mkdirSync(join(root, "dist"), { recursive: true });
for (const arch of ["amd64", "arm64"]) {
	const out = join(root, "dist", `computerd-linux-${arch}`);
	execFileSync(go, ["build", "-trimpath", "-ldflags", `-s -w -X main.version=${version}`, "-o", out, "./cmd/computerd"], {
		cwd: join(root, "daemon"),
		env: { ...process.env, CGO_ENABLED: "0", GOOS: "linux", GOARCH: arch },
		stdio: "inherit",
	});
	console.log(`build:daemon: ${out} (${statSync(out).size} bytes, ${version})`);
}

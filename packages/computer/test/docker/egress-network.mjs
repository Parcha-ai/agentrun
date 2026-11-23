// The live-Docker run's global setup (npm run test:docker): the first allowlist or open computer a file makes also makes
// the provider's egress bridge, which the provider shares between every proxy on the host and never removes. A run that
// found no such network removes it once every file is done, so the run leaves no network it made. A file run on its own,
// outside npm run test:docker, leaves it, as the provider itself does.
import { execFileSync, spawnSync } from "node:child_process";
import { EGRESS_NETWORK } from "../../dist/docker/egress.js";

let made = false;

export function globalSetup() {
	made = spawnSync("docker", ["network", "inspect", EGRESS_NETWORK], { stdio: "ignore" }).status !== 0;
}

export function globalTeardown() {
	if (!made) return;
	const there = spawnSync("docker", ["network", "inspect", EGRESS_NETWORK], { stdio: "ignore" }).status === 0;
	// Docker refuses to remove a network a container is still on: that error, a proxy left behind, fails the run.
	if (there) execFileSync("docker", ["network", "rm", EGRESS_NETWORK], { stdio: ["ignore", "ignore", "inherit"] });
}

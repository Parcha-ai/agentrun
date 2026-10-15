// What a default Daytona box needs before `daytonaHost`'s launcher can run the instance in it: Node, the archil client,
// the run user, this package and its peers with the example's app, the root-owned archil wrapper and its sudoers drop-in,
// and the mount root. Node and the archil client are pinned and checked by sha256. The run user has the same uid as on
// host A: both incarnations write the same store and workspace, and the disk enforces their owners.
import { readFileSync } from "node:fs";
import type { DaytonaClient, SandboxInfo } from "@parcha/pi-durable-disk";

const NODE_URL = "https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz";
const NODE_SHA256 = "fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6";
const ARCHIL_URL = "https://s3.amazonaws.com/archil-client/pkg/archil_0.8.42-1790378297_amd64.deb";
const ARCHIL_SHA256 = "ee593dde01f1c2cbd4ff9cba7852aa87b45f58b97dc328e66e03ced98d9c60d3";

/** Where things go in the box. */
export const BOX = {
  node: "/opt/node24/bin/node",
  appDir: "/opt/pda-app",
  app: "/opt/pda-app/app.ts",
  /**
   * The package, installed under the alias `pda` so its directory is a plain path: the driver takes only letters, digits
   * and `._/-` in a box path, and the in-box launcher must be started by its real path, not through a link.
   */
  packageDir: "/opt/pda-app/node_modules/pda",
  archil: "/usr/local/sbin/archil-scoped",
} as const;

export interface BoxSetup {
  /** The uid and gid the instance runs as, the same as on host A. */
  readonly uid: number;
  readonly gid: number;
  /** The mount root, the same as on host A. */
  readonly mountRoot: string;
  /** The package to install: a local tarball (`npm pack` of a checkout) or an npm spec (`@parcha/pi-durable-disk@0.1.0-beta.14`). */
  readonly pkg: string;
  /** The peers at the versions to install, as npm specs. */
  readonly peers: readonly string[];
  /** The app module to run, uploaded as BOX.app. */
  readonly appFile: string;
}

const DONE = "pda-script-done";

/** One shell word, whatever it holds. */
const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;

/**
 * A shell script run by the box's toolbox user (passwordless sudo in a default image). A non-zero exit throws, and so does
 * an answer without the script's last line: a toolbox can answer exit 0 with no output without having run anything.
 */
async function sh(client: DaytonaClient, box: SandboxInfo, script: string, timeoutSec: number): Promise<string> {
  const r = await client.exec(box, `set -euo pipefail\n${script}\necho ${DONE}`, timeoutSec);
  if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode} in ${box.name}: ${r.result.trim().split("\n").slice(-5).join(" | ").slice(0, 600)}`);
  if (!r.result.includes(DONE)) throw new Error(`the toolbox of ${box.name} answered without running the script (exit 0, ${JSON.stringify(r.result.slice(0, 200))})`);
  return r.result.replace(`${DONE}\n`, "");
}

/** Right after a box reports `started`, its toolbox can answer before it runs commands: wait until it echoes one back. */
async function toolboxReady(client: DaytonaClient, box: SandboxInfo): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const r = await client.exec(box, "echo pda-ready", 30).catch(() => null);
    if (r?.exitCode === 0 && r.result.trim() === "pda-ready") return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`the toolbox of ${box.name} did not run a command within 60 s`);
}

/** `daytonaHost`'s `prepare`: install everything above into a freshly started default box. */
export function prepareBox(setup: BoxSetup) {
  return async (box: SandboxInfo, client: DaytonaClient): Promise<void> => {
    const local = setup.pkg.endsWith(".tgz");
    await toolboxReady(client, box);
    await sh(client, box, "mkdir -p /tmp/pda-upload && chmod 700 /tmp/pda-upload", 60);
    await client.upload(box, "/tmp/pda-upload/app.ts", readFileSync(setup.appFile));
    // A tarball goes up under a fixed name, so nothing of its local path reaches the shell; an npm spec is quoted.
    if (local) await client.upload(box, "/tmp/pda-upload/package.tgz", readFileSync(setup.pkg));
    const pkg = quote(local ? "pda@file:/tmp/pda-upload/package.tgz" : `pda@npm:${setup.pkg}`);
    const { uid, gid, mountRoot } = setup;
    await sh(client, box, String.raw`
cd /tmp
curl -fsSLo node.tar.xz ${NODE_URL}
echo "${NODE_SHA256}  node.tar.xz" | sha256sum -c - >/dev/null
sudo -n install -d -m 0755 /opt/node24
sudo -n tar -xJf node.tar.xz -C /opt/node24 --strip-components=1
rm -f node.tar.xz
curl -fsSLo archil.deb ${ARCHIL_URL}
echo "${ARCHIL_SHA256}  archil.deb" | sha256sum -c - >/dev/null
sudo -n env DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null
sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends libfuse2t64 fuse3 /tmp/archil.deb >/dev/null
rm -f archil.deb
# The run user: whatever account has host A's uid, or a new one.
getent group ${gid} >/dev/null || sudo -n groupadd --gid ${gid} pda
getent passwd ${uid} >/dev/null || sudo -n useradd --uid ${uid} --gid ${gid} --create-home --shell /bin/bash pda
sudo -n install -d -m 0755 ${BOX.appDir}
echo '{"private":true,"type":"module"}' | sudo -n tee ${BOX.appDir}/package.json >/dev/null
sudo -n env PATH=/opt/node24/bin:/usr/bin:/bin HOME=/root npm install --prefix ${BOX.appDir} --no-audit --no-fund --loglevel=error ${pkg} ${setup.peers.map(quote).join(" ")} >/dev/null
sudo -n install -m 0644 /tmp/pda-upload/app.ts ${BOX.app}
sudo -n chown -R root:root ${BOX.appDir}
sudo -n chmod -R a+rX,go-w ${BOX.appDir}
sudo -n install -o root -g root -m 0755 ${BOX.packageDir}/bin/archil-scoped ${BOX.archil}
printf '%s\n' '#${uid} ALL=(root) NOPASSWD: ${BOX.archil}, /usr/bin/fusermount -u ${mountRoot}/runs/*' | sudo -n tee /etc/sudoers.d/pi-durable-disk >/dev/null
sudo -n chmod 0440 /etc/sudoers.d/pi-durable-disk
sudo -n visudo -cf /etc/sudoers.d/pi-durable-disk >/dev/null
sudo -n install -d -m 0755 ${mountRoot}
sudo -n install -d -o ${uid} -g ${gid} -m 0755 ${mountRoot}/runs
rm -rf /tmp/pda-upload
`, 900);
  };
}

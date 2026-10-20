// What a Modal VM needs before `modalHost`'s launcher can run the session in it: Node and the archil client (both pinned and checked
// by sha256), the run user, this package, pi-transport (not on npm yet: a tarball of the checkout), the Modal SDK, the example's own
// files, the root-owned archil wrapper and its sudoers line. Modal runs the driver's commands as root.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const NODE_URL = "https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz";
const NODE_SHA256 = "fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6";
const ARCHIL_URL = "https://s3.amazonaws.com/archil-client/pkg/archil_0.8.42-1790378297_amd64.deb";
const ARCHIL_SHA256 = "ee593dde01f1c2cbd4ff9cba7852aa87b45f58b97dc328e66e03ced98d9c60d3";

/** Where things go in the VM. The package sits under the alias `pda`, so its directory is a plain path the launcher can name. */
export const VM = {
  node: "/opt/node24/bin/node",
  dir: "/opt/moves",
  app: "/opt/moves/app.ts",
  packageDir: "/opt/moves/node_modules/pda",
  archil: "/usr/local/sbin/archil-scoped",
  mountRoot: "/mnt/pda/moves",
} as const;

/** Dockerfile commands for the image: what the pinned downloads and the sudoers drop-in need. */
export const IMAGE_COMMANDS = ["RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends sudo curl ca-certificates xz-utils && rm -rf /var/lib/apt/lists/*"];

export interface VmSetup {
  readonly uid: number;
  readonly gid: number;
  /** Tarballs of this checkout's packages (`npm pack`), uploaded and installed. */
  readonly packageTarball: Uint8Array;
  readonly transportTarball: Uint8Array;
  /** The example's own files, one tar.gz. */
  readonly appTarball: Uint8Array;
  /** The peers and the Modal SDK, as npm specs. */
  readonly peers: readonly string[];
}

const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;

export function prepareScript(setup: Pick<VmSetup, "uid" | "gid" | "peers">): string {
  const { uid, gid } = setup;
  return String.raw`
set -euo pipefail
cd /tmp
curl -fsSLo node.tar.xz ${NODE_URL}
echo "${NODE_SHA256}  node.tar.xz" | sha256sum -c - >/dev/null
install -d -m 0755 /opt/node24
tar -xJf node.tar.xz -C /opt/node24 --strip-components=1
chmod -R a+rX /opt/node24
rm -f node.tar.xz
curl -fsSLo archil.deb ${ARCHIL_URL}
echo "${ARCHIL_SHA256}  archil.deb" | sha256sum -c - >/dev/null
DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends libfuse2t64 fuse3 /tmp/archil.deb >/dev/null
rm -f archil.deb
getent group ${gid} >/dev/null || groupadd --gid ${gid} pda
getent passwd ${uid} >/dev/null || useradd --uid ${uid} --gid ${gid} --create-home --shell /bin/bash pda
install -d -m 0755 ${VM.dir}
tar -xzf /tmp/moves-app.tgz -C ${VM.dir} --no-same-owner
echo '{"private":true,"type":"module"}' > ${VM.dir}/package.json
PATH=/opt/node24/bin:/usr/bin:/bin HOME=/root npm install --prefix ${VM.dir} --no-audit --no-fund --loglevel=error pda@file:/tmp/pda.tgz file:/tmp/transport.tgz ${setup.peers.map(quote).join(" ")} >/dev/null
rm -f /tmp/pda.tgz /tmp/transport.tgz /tmp/moves-app.tgz
chown -R root:root ${VM.dir}
chmod -R a+rX,go-w ${VM.dir}
install -o root -g root -m 0755 ${VM.packageDir}/bin/archil-scoped ${VM.archil}
printf '%s\n' '#${uid} ALL=(root) NOPASSWD: ${VM.archil}, /usr/bin/fusermount -u ${VM.mountRoot}/runs/*' > /etc/sudoers.d/pi-durable-disk
chmod 0440 /etc/sudoers.d/pi-durable-disk
visudo -cf /etc/sudoers.d/pi-durable-disk >/dev/null
install -d -m 0755 /mnt/pda ${VM.mountRoot}
install -d -o ${uid} -g ${gid} -m 0755 ${VM.mountRoot}/runs
echo pda-script-done
`;
}

/** `modalHost`'s `prepare`: upload the tarballs and run the script in a fresh VM. */
export function prepareVm(setup: VmSetup) {
  type Client = { upload(box: unknown, path: string, bytes: Uint8Array): Promise<void>; exec(box: unknown, script: string, timeoutSec: number): Promise<{ exitCode: number; result: string }> };
  return async (box: unknown, client: Client): Promise<void> => {
    await client.upload(box, "/tmp/pda.tgz", setup.packageTarball);
    await client.upload(box, "/tmp/transport.tgz", setup.transportTarball);
    await client.upload(box, "/tmp/moves-app.tgz", setup.appTarball);
    const r = await client.exec(box, `bash -c ${quote(prepareScript(setup))}`, 900);
    if (r.exitCode !== 0 || !r.result.includes("pda-script-done")) throw new Error(`preparing the VM failed (exit ${r.exitCode}): ${r.result.trim().split("\n").slice(-5).join(" | ").slice(0, 600)}`);
  };
}

/** A tarball of a checkout's package directory (`npm pack`), read into memory. The checkout must be built. */
export function packTarball(packageDir: string, into: string): Uint8Array {
  const packed = spawnSync("npm", ["pack", "--silent", "--pack-destination", into], { cwd: packageDir, encoding: "utf8" });
  if (packed.status !== 0) throw new Error(`npm pack in ${packageDir} failed: ${String(packed.stderr).slice(-300)}`);
  const name = String(packed.stdout).trim().split("\n").at(-1)!;
  return readFileSync(`${into}/${name}`);
}

/** The example's own files as one tar.gz (the directory this file is in). */
export function appTarball(dir: string): Uint8Array {
  const tar = spawnSync("tar", ["czf", "-", "-C", dir, "--exclude=*.md", "."], { maxBuffer: 16 * 1024 * 1024 });
  if (tar.status !== 0) throw new Error(`tar of the example failed: ${String(tar.stderr).slice(-300)}`);
  return new Uint8Array(tar.stdout);
}

// What a Modal VM needs before `modalHost`'s launcher can run the session's process in it: Node and the archil client (both pinned and checked by
// sha256), the run user, the disk package at one plain path with the workspace packages the harness's child app imports (tarballs of this checkout,
// installed over it), the Modal SDK the threads' sandboxes are made with, this example's own files, the root-owned archil wrapper and its sudoers
// line. Modal runs the driver's commands as root.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const NODE_URL = "https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz";
const NODE_SHA256 = "fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6";
const ARCHIL_URL = "https://s3.amazonaws.com/archil-client/pkg/archil_0.8.42-1790378297_amd64.deb";
const ARCHIL_SHA256 = "ee593dde01f1c2cbd4ff9cba7852aa87b45f58b97dc328e66e03ced98d9c60d3";

/** Where things go in the VM. The disk package's directory is a plain path the launcher can name; the example sits under it, so its imports resolve from the package's `node_modules`. */
export const VM = {
  node: "/opt/node24/bin/node",
  packageDir: "/opt/moves/pkg",
  demoDir: "/opt/moves/pkg/demo/examples/moves",
  archil: "/usr/local/sbin/archil-scoped",
  mountRoot: "/mnt/pda/moves",
} as const;

/** Dockerfile commands for the image: what the pinned downloads and the sudoers drop-in need. */
export const IMAGE_COMMANDS = ["RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends sudo curl ca-certificates xz-utils && rm -rf /var/lib/apt/lists/*"];

/** The workspace packages the child app imports, by directory under `packages/` (the disk package itself is `disk`, apart). */
export const PACKS = ["dsl", "pi", "pi-browser", "pi-vision", "pi-transport", "harness"] as const;

export interface VmSetup {
  readonly uid: number;
  readonly gid: number;
  /** `npm pack` of the disk package: it becomes the package directory. */
  readonly disk: Uint8Array;
  /** `npm pack` of each of `PACKS`, by the file name each is uploaded as. */
  readonly packs: Readonly<Record<string, Uint8Array>>;
  /** The example's own files, one tar.gz. */
  readonly app: Uint8Array;
  /** What npm installs with them, as specs: the peers at the versions this checkout was tested with, pi-codemode, the Modal SDK. */
  readonly extra: readonly string[];
}

const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;

export function prepareScript(setup: Pick<VmSetup, "uid" | "gid" | "extra">): string {
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
install -d -m 0755 ${VM.packageDir} ${VM.demoDir}
tar -xzf /tmp/packs/disk.tgz -C ${VM.packageDir} --strip-components=1 --no-same-owner
tar -xzf /tmp/moves-app.tgz -C ${VM.demoDir} --no-same-owner
PATH=/opt/node24/bin:/usr/bin:/bin HOME=/root npm install --prefix ${VM.packageDir} --no-save --no-audit --no-fund --loglevel=error /tmp/packs/*.tgz ${setup.extra.map(quote).join(" ")} >/dev/null
rm -rf /tmp/packs /tmp/moves-app.tgz
chown -R root:root /opt/moves
chmod -R a+rX,go-w /opt/moves
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
    await client.exec(box, "mkdir -p /tmp/packs", 60);
    // The disk package is both the package directory and, installed over it, the copy the harness's own import of it resolves to.
    await client.upload(box, "/tmp/packs/disk.tgz", setup.disk);
    for (const [file, bytes] of Object.entries(setup.packs)) await client.upload(box, `/tmp/packs/${file}`, bytes);
    await client.upload(box, "/tmp/moves-app.tgz", setup.app);
    const r = await client.exec(box, `bash -c ${quote(prepareScript(setup))}`, 900);
    if (r.exitCode !== 0 || !r.result.includes("pda-script-done")) throw new Error(`preparing the VM failed (exit ${r.exitCode}): ${r.result.trim().split("\n").slice(-5).join(" | ").slice(0, 600)}`);
  };
}

/** `npm pack` of a checkout's package directory, into `into`: the file's name and bytes. The checkout must be built (the pack ships `dist/`). */
export function packTarball(packageDir: string, into: string): { file: string; bytes: Uint8Array } {
  const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--silent", "--pack-destination", into], { cwd: packageDir, encoding: "utf8" });
  if (packed.status !== 0) throw new Error(`npm pack in ${packageDir} failed: ${String(packed.stderr).slice(-300)}`);
  const file = String(packed.stdout).trim().split("\n").at(-1)!;
  return { file, bytes: readFileSync(`${into}/${file}`) };
}

/** The example's own files as one tar.gz (the directory this file is in), without its notes and its live runner. */
export function appTarball(dir: string): Uint8Array {
  const tar = spawnSync("tar", ["czf", "-", "-C", dir, "--exclude=*.md", "--exclude=live.ts", "."], { maxBuffer: 16 * 1024 * 1024 });
  if (tar.status !== 0) throw new Error(`tar of the example failed: ${String(tar.stderr).slice(-300)}`);
  return new Uint8Array(tar.stdout);
}

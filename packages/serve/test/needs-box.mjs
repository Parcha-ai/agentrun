// Docker's stand-in for the computer-needs check (computer-for-claim.ts), shared by the runner's tests and the server's: a
// box over the run's folder that answers the check's `sh` with the names it lacks.
import { fakeComputer } from "./workspace-fake-computer.mjs";

const HELLO = { version: "0", os: "linux", kind: "linux", arch: "amd64", groups: ["exec", "files", "processes"] };

/** The `sh` the check runs: the names after `sh -c <script> sh`. */
export const checked = (argv) => (argv[0] === "sh" && argv[1] === "-c" && argv[3] === "sh" ? argv.slice(4) : undefined);

/** A folder only the image's own PATH names: an exec given no PATH inherits it (as computerd's default does), one given
 *  the shell's fixed PATH does not search it. */
const IMAGE_ONLY_DIR = "/opt/media/bin";

/** A box whose PATH has `has`, and `imageOnly` in IMAGE_ONLY_DIR, found only by an exec whose PATH names that folder or
 *  that gives none. `provider` is the box's provider under the id `id`; `load` loads it, as the runner loads a provider.
 *  Each exec.run's argv is kept in `execs`, its env in `envs`; `fails`, when set, is what an exec.run answers instead (a
 *  box that cannot be asked). `made` and `released` list the boxes started and let go. */
export function needsBox(has, { imageOnly = [], id = "docker" } = {}) {
  const made = [];
  const released = [];
  const execs = [];
  const envs = [];
  const box = { made, released, execs, envs, fails: undefined };
  box.provider = {
    id,
    version: "0",
    capabilities: () => ({ lifetime: "janitor", maxLifetimeMs: 86_400_000 }),
    check: () => [],
    prepareImage: async () => ({ ok: true, value: "agentrun/computer:prepared" }),
    list: async () => ({ ok: true, value: [] }),
    async create(spec) {
      const ref = { id: `c${made.length + 1}`, name: `c${made.length + 1}` };
      made.push({ ref, computer: fakeComputer(spec.mount.path, { exec: (params) => {
        const names = checked(params.argv) ?? [];
        const path = params.env?.PATH;
        const searchesImageOnly = path === undefined || path.split(":").includes(IMAGE_ONLY_DIR);
        const missing = names.filter((name) => !has.includes(name) && !(searchesImageOnly && imageOnly.includes(name)));
        return { exitCode: 0, stdout: Buffer.from(missing.map((name) => `${name}\n`).join("")), stderr: new Uint8Array(0), timedOut: false, truncated: false };
      } }) });
      return { ok: true, value: ref };
    },
    async connect(ref) {
      const one = made.find((each) => each.ref.id === ref.id);
      const client = {
        async call(method, params, options) {
          if (method === "exec.run") {
            execs.push(params.argv);
            envs.push(params.env);
            if (box.fails) return box.fails;
          }
          return one.computer.client.call(method, params, options);
        },
        close() {},
      };
      return { ok: true, value: { client, hello: HELLO, close: async () => {} } };
    },
    async attach(ref) {
      const one = made.find((each) => each.ref.id === ref.id);
      if (!one) return { ok: false, error: { code: "not_found", message: `no fake computer has the id ${ref.id}` } };
      const read = await one.computer.readBack();
      return { ok: true, value: { ...ref, spec: { image: "i", user: "1000:1000", network: "none", ...(read.ok ? { mount: read.value } : {}) } } };
    },
    async release(ref) {
      released.push(ref.id);
      return { ok: true, value: undefined };
    },
  };
  box.load = async () => box.provider;
  return box;
}

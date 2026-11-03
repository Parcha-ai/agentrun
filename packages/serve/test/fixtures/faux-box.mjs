// A faux box provider standing in for Docker (`startServe({ fauxBox })`): pi-transport's local box, its workspace the
// source of the spec's work mount, so a command's files land in the run's work/ as a bind would put them. The box says
// its workspace is the mount's target, and its commands' arguments name the target, mapped to the source as they run,
// so every path the box's environment uses or reports is the box's, as on Docker. A local box
// shares this machine (its files, /proc and network), so what it proves is the wiring: what the spec asks, which
// environment a command gets, and when a box is made, found and destroyed. Every spec, and every command a box runs, is
// written down under `<data>/faux-boxes/` for the tests to read.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { localBoxes } from "@parcha/pi-transport/box/local";

export const fauxRoot = (data) => join(data, "faux-boxes");
const lines = (file) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);

export default function fauxBoxes(data) {
  const root = fauxRoot(data);
  mkdirSync(root, { recursive: true });
  const local = localBoxes({ root });
  const note = (file, value) => appendFileSync(join(root, file), `${JSON.stringify(value)}\n`);
  // Each box's work mount, by its id: kept by the create, read back from the spec log by a process that attaches.
  const mounts = new Map();
  const mountOf = (box) => {
    const workspace = box.facts().workspace;
    const spec = lines(join(root, "specs.jsonl")).find((s) => s.mounts?.some((m) => m.source === workspace));
    return spec?.mounts.find((m) => m.source === workspace);
  };
  const counted = (box, work) => ({
    id: box.id,
    facts: () => ({ ...box.facts(), ...(work ? { workspace: work.target } : {}) }),
    exec: (command, options, context) => {
      note("execs.jsonl", { box: box.id, command: command.slice(0, 2) });
      return box.exec(work ? command.map((arg) => arg.split(work.target).join(work.source)) : command, options, context);
    },
    upload: (files, context) => box.upload(files, context),
    download: (paths, context) => box.download(paths, context),
    status: (context) => box.status(context),
    destroy: (context) => (note("destroyed.jsonl", { box: box.id }), box.destroy(context)),
  });
  return {
    name: "faux",
    mounts: true,
    async create(spec, context) {
      note("specs.jsonl", spec);
      const work = spec.mounts?.find((mount) => mount.target === spec.workspace);
      const { mounts: _mounts, network: _network, workspace: _workspace, ...rest } = spec;
      const made = await local.create({ ...rest, ...(work ? { workspace: work.source } : {}) }, context);
      if (made.ok && work) mounts.set(made.value.id, work);
      return made.ok ? { ok: true, value: counted(made.value, work) } : made;
    },
    async attach(id, context) {
      const found = await local.attach(id, context);
      if (found.ok && found.value && !mounts.has(id)) mounts.set(id, mountOf(found.value));
      return found.ok && found.value ? { ok: true, value: counted(found.value, mounts.get(id)) } : found;
    },
    list: (labels, context) => local.list(labels, context),
  };
}

// P8's resource ledger: every token user, subdirectory, mount, systemd unit, supervise process and system file the P8 lane
// creates is written here the moment it exists, and stamped when it is removed. Identifiers only; never a token.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { statePath } from "./_paths.ts";

export const LEDGER = statePath("PDA_P8_STATE", "P8-STATE.json");

type Entry = Record<string, unknown>;
type Ledger = {
  lane: "P8";
  disk: string | null;
  tokenUsers: Entry[];
  subdirectories: Entry[];
  mounts: Entry[];
  units: Entry[];
  files: Entry[];
  events: Entry[];
};

function load(): Ledger {
  if (!existsSync(LEDGER)) return { lane: "P8", disk: null, tokenUsers: [], subdirectories: [], mounts: [], units: [], files: [], events: [] };
  return JSON.parse(readFileSync(LEDGER, "utf8")) as Ledger;
}

function update(fn: (l: Ledger) => void): void {
  const l = load();
  fn(l);
  mkdirSync(dirname(LEDGER), { recursive: true });
  writeFileSync(LEDGER, JSON.stringify(l, null, 2) + "\n");
}

const now = () => new Date().toISOString();
const stamp = (list: Entry[], key: string, value: string, fields: Entry) =>
  list.filter((e) => e[key] === value && !e.closedAt).forEach((e) => Object.assign(e, { closedAt: now(), ...fields }));

export const ledger = {
  disk(id: string) {
    update((l) => void (l.disk = id));
  },
  token(identifier: string, nickname: string, purpose: string) {
    update((l) => void l.tokenUsers.push({ identifier, nickname, purpose, createdAt: now() }));
  },
  tokenRemoved(identifier: string, how = "removeUser") {
    update((l) => stamp(l.tokenUsers, "identifier", identifier, { how }));
  },
  subdir(key: string, purpose: string) {
    update((l) => void l.subdirectories.push({ key, purpose, createdAt: now() }));
  },
  subdirDeleted(key: string, objects: number) {
    update((l) => stamp(l.subdirectories, "key", key, { objects }));
  },
  mount(mountpoint: string, target: string) {
    update((l) => void l.mounts.push({ mountpoint, target, createdAt: now() }));
  },
  unmounted(mountpoint: string, via: string) {
    update((l) => stamp(l.mounts, "mountpoint", mountpoint, { via }));
  },
  unit(name: string, purpose: string) {
    update((l) => void l.units.push({ name, purpose, createdAt: now() }));
  },
  unitGone(name: string, how: string) {
    update((l) => stamp(l.units, "name", name, { how }));
  },
  file(path: string, purpose: string) {
    update((l) => void l.files.push({ path, purpose, createdAt: now() }));
  },
  fileRemoved(path: string) {
    update((l) => stamp(l.files, "path", path, {}));
  },
  event(kind: string, detail: Entry = {}) {
    update((l) => void l.events.push({ at: now(), kind, ...detail }));
  },
  open(): Ledger {
    return load();
  },
};

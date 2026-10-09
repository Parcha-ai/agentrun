// P1's resource ledger: every token user, subdirectory and mount the claim lane creates on the shared scratch disk is
// written here the moment it exists, and stamped when it is removed. Identifiers only; never a token.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { statePath } from "./_paths.ts";

export const LEDGER = statePath("PDA_P1_STATE", "P1-STATE.json");

type Entry = Record<string, unknown>;
type Ledger = { lane: "P1"; disk: string | null; tokenUsers: Entry[]; subdirectories: Entry[]; mounts: Entry[]; events: Entry[] };

function load(): Ledger {
  if (!existsSync(LEDGER)) return { lane: "P1", disk: null, tokenUsers: [], subdirectories: [], mounts: [], events: [] };
  return JSON.parse(readFileSync(LEDGER, "utf8")) as Ledger;
}

function update(fn: (l: Ledger) => void): void {
  const l = load();
  fn(l);
  mkdirSync(dirname(LEDGER), { recursive: true });
  writeFileSync(LEDGER, JSON.stringify(l, null, 2) + "\n");
}

const now = () => new Date().toISOString();

export const ledger = {
  disk(id: string) {
    update((l) => void (l.disk = id));
  },
  token(identifier: string, nickname: string, purpose: string) {
    update((l) => void l.tokenUsers.push({ identifier, nickname, purpose, createdAt: now() }));
  },
  tokenRemoved(identifier: string) {
    update((l) => l.tokenUsers.filter((t) => t.identifier === identifier && !t.removedAt).forEach((t) => (t.removedAt = now())));
  },
  subdir(key: string, purpose: string) {
    update((l) => void l.subdirectories.push({ key, purpose, createdAt: now() }));
  },
  subdirDeleted(key: string, objects: number) {
    update((l) => l.subdirectories.filter((s) => s.key === key && !s.deletedAt).forEach((s) => Object.assign(s, { deletedAt: now(), objects })));
  },
  mount(mountpoint: string, target: string) {
    update((l) => void l.mounts.push({ mountpoint, target, mountedAt: now() }));
  },
  unmounted(mountpoint: string, via: string) {
    update((l) => l.mounts.filter((m) => m.mountpoint === mountpoint && !m.unmountedAt).forEach((m) => Object.assign(m, { unmountedAt: now(), via })));
  },
  event(kind: string, detail: Entry = {}) {
    update((l) => void l.events.push({ at: now(), kind, ...detail }));
  },
  open(): Ledger {
    return load();
  },
};

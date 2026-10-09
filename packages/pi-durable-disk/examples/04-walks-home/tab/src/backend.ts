// Storage backends for the creature's SQLite file.
//
// ParentBackend asks the embedding page (the show page, or a 03 tab) to read and write the file on the agent's disk
// (work/creature/*.sqlite) with postMessage, so the app does not need to know how the disk is reached. A write
// resolves only when the parent answers "storage-written", which the parent sends after the disk has it; a write the
// parent does not answer rejects, and the store reports it instead of showing rows the disk lacks.
//
// Messages (ns "walks-home"):
//   tab -> parent: storage-read {id, path, ifNoneMatch?} | storage-write {id, path, bytes}
//   parent -> tab: storage-result {id, bytes: Uint8Array | null, etag?, notModified?, error?} | storage-written {id, error?}
// `ifNoneMatch`/`etag`/`notModified` are optional: a parent that ignores them just sends the bytes again.
// A write is refused with error "not-holder" (HTTP 409 at the server) while another machine holds the run: this tab is
// then a viewer, `NotHolder` is thrown, and the app turns the edit into a `design-request` for the running agent.

import type { PolicySource } from './arrival.ts';
import type { Backend } from './store.ts';

export const DESIGNS_PATH = 'creature/designs.sqlite'; // written by the tab
export const MEMORY_PATH = 'creature/memory.sqlite'; // written by the agent, read by the tab
const NS = 'walks-home';

export interface Bus {
  send(msg: Record<string, unknown>): void;
  /** Subscribe to messages from the parent; returns an unsubscribe function. */
  listen(fn: (msg: Record<string, unknown>) => void): () => void;
}

export class StorageTimeout extends Error {}
export class NotHolder extends Error {}

// Request ids are unique per page, not per backend: several backends share one bus and one parent.
let nextRequestId = 1;

export class ParentBackend implements Backend {
  private readonly bus: Bus;
  private readonly path: string;
  private readonly timeoutMs: number;

  constructor(bus: Bus, path: string, timeoutMs = 5000) {
    this.bus = bus;
    this.path = path;
    this.timeoutMs = timeoutMs;
  }

  private request(type: string, body: Record<string, unknown>, answer: string, timeoutMs = this.timeoutMs): Promise<Record<string, unknown>> {
    const id = nextRequestId++;
    return new Promise((resolve, reject) => {
      const off = this.bus.listen((m) => {
        if (m.ns !== NS || m.type !== answer || m.id !== id) return;
        clearTimeout(timer);
        off();
        if (m.error === 'not-holder') reject(new NotHolder('another machine holds the run'));
        else if (m.error) reject(new Error(String(m.error)));
        else resolve(m);
      });
      const timer = setTimeout(() => { off(); reject(new StorageTimeout(`${type} not answered in ${timeoutMs} ms`)); }, timeoutMs);
      this.bus.send({ ns: NS, type, id, path: this.path, ...body });
    });
  }

  /** True when a parent answers a read within `timeoutMs`: the page is embedded in something that holds the disk. */
  async probe(timeoutMs = 1500): Promise<Uint8Array | null | undefined> {
    try {
      const m = await this.request('storage-read', {}, 'storage-result', timeoutMs);
      return (m.bytes as Uint8Array | null) ?? null;
    } catch (e) {
      if (e instanceof StorageTimeout) return undefined; // nobody home
      throw e;
    }
  }

  async read(): Promise<Uint8Array | null> {
    const m = await this.request('storage-read', {}, 'storage-result');
    return (m.bytes as Uint8Array | null) ?? null;
  }

  /** Like read(), for polling: pass the last etag; a parent that supports it answers `unchanged` instead of the bytes. */
  async readIfChanged(etag?: string): Promise<{ bytes: Uint8Array; etag?: string } | 'unchanged' | null> {
    const m = await this.request('storage-read', etag ? { ifNoneMatch: etag } : {}, 'storage-result');
    if (m.notModified === true) return 'unchanged';
    const bytes = (m.bytes as Uint8Array | null) ?? null;
    return bytes ? { bytes, etag: typeof m.etag === 'string' ? m.etag : undefined } : null;
  }

  async write(bytes: Uint8Array): Promise<void> {
    await this.request('storage-write', { bytes }, 'storage-written');
  }
}

/** A bus over window.postMessage to the parent frame, accepting only same-origin messages from it. */
export function windowBus(win: Window = window): Bus {
  return {
    send: (msg) => win.parent.postMessage(msg, win.location.origin),
    listen: (fn) => {
      const h = (ev: MessageEvent) => {
        if (ev.origin !== win.location.origin || ev.source !== win.parent) return;
        if (ev.data && typeof ev.data === 'object') fn(ev.data);
      };
      win.addEventListener('message', h);
      return () => win.removeEventListener('message', h);
    },
  };
}

/** The trained policy as the embedding page's storage holds it (work/home/policy.json), as a PolicySource. */
export function parentPolicySource(backend: ParentBackend): PolicySource {
  return {
    async read(etag) {
      const got = await backend.readIfChanged(etag);
      if (got === null || got === 'unchanged') return got;
      return { text: new TextDecoder().decode(got.bytes), etag: got.etag };
    },
  };
}

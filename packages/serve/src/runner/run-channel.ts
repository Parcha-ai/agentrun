// The channel between a runner and a run's own process (run-child.ts): one inherited Unix socket, frames of a 4-byte
// length and a V8-serialized message, at most MAX_FRAME bytes each. Either side calls the other: a call names a target
// (a name the other side exposed, or a handle it was given) and a method, and is answered with a value or an error.
//
// What crosses is data, with three exceptions, each passed by reference as a handle the receiver calls back through:
// a function, an object with methods (a computer, a Workspace), and an AbortSignal (its abort is posted across). The
// sender keeps what it handed until the receiver's stand-in of it is collected (a release is then posted) or the
// channel ends, so a long run's callbacks do not pile up on either side. An
// error crosses as its name, message, code and own fields, made again on the other side as an instance of the class of
// that name when ERRORS lists it, so `instanceof Fenced` holds across the channel.
//
// The runner's side treats every frame as untrusted: the run's process runs code nodes and extensions. A frame over the
// cap, one that does not deserialize, or one that is not a message is the end of the channel (onClose), and the runner
// fails the run. A call to a target nobody exposed, or to a method a handle's object does not have, is refused. What a
// target lets a call do is the target's own business (run-child-host.ts binds each to the claim).
import { deserialize, serialize } from "node:v8";
import type { Duplex } from "node:stream";

/** The most a frame may hold, in bytes: a journal commit of a long turn fits many times over. */
export const MAX_FRAME = 32 * 1024 * 1024;

/** The channel ended: its socket closed, or a frame broke the protocol. Every call in flight fails with it. */
export class ChannelClosed extends Error {
  override name = "ChannelClosed";
}

/** A call the other side refused before running it: no such target or method. */
export class ChannelRefused extends Error {
  override name = "ChannelRefused";
}

/** The error classes made again by name on the receiving side, so instanceof holds across the channel. Each side
 *  registers the ones it may receive (registerErrors). */
const ERRORS = new Map<string, abstract new (...args: never[]) => Error>();
export function registerErrors(classes: Record<string, abstract new (...args: never[]) => Error>): void {
  for (const [name, type] of Object.entries(classes)) ERRORS.set(name, type);
}

/** What a target exposed by name does with a call: its method and arguments, as decoded. */
export type Dispatch = (method: string, args: unknown[]) => unknown;

const TAG = "\u0000agentrun-rpc";
/** A post that aborts the stand-in of the sender's signal. */
const ABORT = "\u0000abort";
/** A post that tells the sender its handle's stand-in was let go of: it lets go of what it handed under it. */
const RELEASE = "\u0000release";
type Tagged =
  | { [TAG]: "fn"; h: number }
  | { [TAG]: "obj"; h: number; data: Record<string, unknown>; methods: string[] }
  | { [TAG]: "signal"; h: number; aborted: boolean; reason?: unknown }
  | { [TAG]: "error"; name: string; message: string; stack?: string; fields: Record<string, unknown> };

type Message =
  | { t: "call"; id: number; to: string | number; m: string; a: unknown[]; c?: unknown }
  | { t: "ok"; id: number; v: unknown }
  | { t: "err"; id: number; e: unknown }
  | { t: "post"; to: string | number; m: string; a: unknown[] };

const isPlain = (value: object): boolean => {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** The names of `value`'s methods: its own and its prototypes', up to Object's, never the constructor. */
function methodsOf(value: object): string[] {
  const names = new Set<string>();
  for (let at: object | null = value; at && at !== Object.prototype && at !== Function.prototype; at = Object.getPrototypeOf(at)) {
    for (const name of Object.getOwnPropertyNames(at)) {
      if (name === "constructor") continue;
      const descriptor = Object.getOwnPropertyDescriptor(at, name);
      if (descriptor && typeof descriptor.value === "function") names.add(name);
    }
  }
  return [...names];
}

/** Sets `key` as `target`'s own property, even "__proto__": a decoded key never reaches a setter or a prototype. */
const own = (target: Record<string, unknown>, key: string, value: unknown): void => {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
};

/** Whether `value` holds a function anywhere (itself, or a member): it then crosses as a handle. */
const hasMethods = (value: object): boolean => methodsOf(value).length > 0;

export interface ChannelOptions {
  /** The most a frame may hold (MAX_FRAME). */
  readonly maxFrame?: number;
  /** Called once when the channel ends, with why. */
  readonly onClose?: (why: Error) => void;
  /** What each call this side makes carries beside its arguments, encoded as they are (a run's process: the ledger of
   *  the tool call it is made in, paid-calls.ts). None: nothing. */
  readonly context?: () => unknown;
  /** Runs each call the other side makes inside what it carried (a runner: paid-calls.ts bookedIn on that ledger). */
  readonly within?: (carried: unknown, run: () => unknown) => unknown;
}

/** One side of the channel over `socket`. */
export class Channel {
  readonly #socket: Duplex;
  readonly #maxFrame: number;
  readonly #onClose: ((why: Error) => void) | undefined;
  readonly #context: (() => unknown) | undefined;
  readonly #within: ((carried: unknown, run: () => unknown) => unknown) | undefined;
  #next = 1;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  /** What this side handed the other by reference: functions and objects with methods, each kept until the other side
   *  lets go of its stand-in (RELEASE) or the channel ends. */
  readonly #handles = new Map<number, unknown>();
  /** This side's signals the other side holds a stand-in of: the listener that posts each one's abort, removed when the
   *  other side lets go of it. */
  readonly #handedSignals = new Map<number, { readonly signal: AbortSignal; readonly listener: () => void }>();
  /** The stand-ins of the other side's signals, by its handle: each aborted here when it aborts there. Held weakly, so a
   *  stand-in nobody here holds any more is let go of (and the other side told). */
  readonly #signals = new Map<number, WeakRef<AbortSignal>>();
  /** Each stand-in signal's controller, alive as long as the signal is. */
  readonly #controllers = new WeakMap<AbortSignal, AbortController>();
  /** Tells the other side, once a stand-in of its handle is collected here, that it may let go of what it handed. */
  readonly #released = new FinalizationRegistry<number>((h) => {
    this.#signals.delete(h);
    this.post(h, RELEASE, []);
  });
  readonly #targets = new Map<string, Dispatch>();
  #buffer: Buffer = Buffer.alloc(0);
  #closed: Error | undefined;

  constructor(socket: Duplex, options: ChannelOptions = {}) {
    this.#socket = socket;
    this.#maxFrame = options.maxFrame ?? MAX_FRAME;
    this.#onClose = options.onClose;
    this.#context = options.context;
    this.#within = options.within;
    socket.on("data", (chunk: Buffer) => this.#read(chunk));
    socket.on("error", (error) => this.close(new ChannelClosed(`the channel's socket failed: ${error.message}`)));
    socket.on("close", () => this.close(new ChannelClosed("the channel's socket closed")));
  }

  get closed(): boolean {
    return this.#closed !== undefined;
  }

  /** How many functions, objects and signals this side has handed the other and still keeps for it. */
  get handed(): number {
    return this.#handles.size + this.#handedSignals.size;
  }

  /** Answers calls to `name` with `dispatch`. */
  expose(name: string, dispatch: Dispatch): void {
    this.#targets.set(name, dispatch);
  }

  /** Calls `method` of target `to` with `args`: its answer, or its error. */
  call(to: string | number, method: string, args: readonly unknown[]): Promise<unknown> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      const carried = this.#context?.();
      this.#send({ t: "call", id, to, m: method, a: args.map((arg) => this.#encode(arg)), ...(carried !== undefined ? { c: this.#encode(carried) } : {}) });
    });
  }

  /** Sends `method` of target `to` with `args`, with no answer. In order with every call. */
  post(to: string | number, method: string, args: readonly unknown[]): void {
    if (this.#closed) return;
    this.#send({ t: "post", to, m: method, a: args.map((arg) => this.#encode(arg)) });
  }

  /** A stand-in for target `name`: `stub.a.b(...args)` calls method "a.b" of it. `props`: values read without a call. */
  remote<T>(name: string, props: Record<string, unknown> = {}): T {
    const channel = this;
    const at = (path: string): unknown =>
      new Proxy(function () {}, {
        get(_target, key) {
          if (typeof key === "symbol") return undefined;
          const next = path ? `${path}.${key}` : key;
          if (Object.hasOwn(props, next)) return props[next];
          // A promise-like check (await stub) must not read a method named "then".
          if (key === "then") return undefined;
          return at(next);
        },
        apply(_target, _this, args: unknown[]) {
          return channel.call(name, path, args);
        },
      });
    return at("") as T;
  }

  /** Ends the channel: every call in flight fails with `why`, and the socket is destroyed. */
  close(why: Error = new ChannelClosed("the channel was closed")): void {
    if (this.#closed) return;
    this.#closed = why;
    for (const { reject } of this.#pending.values()) reject(why);
    this.#pending.clear();
    for (const ref of this.#signals.values()) {
      const signal = ref.deref();
      if (signal) this.#controllers.get(signal)?.abort(why);
    }
    this.#signals.clear();
    this.#handles.clear();
    for (const { signal, listener } of this.#handedSignals.values()) signal.removeEventListener("abort", listener);
    this.#handedSignals.clear();
    this.#socket.destroy();
    this.#onClose?.(why);
  }

  #send(message: Message): void {
    let body: Buffer;
    try {
      body = serialize(message);
    } catch (error) {
      // A value that cannot cross (a class V8 cannot clone): the call fails, never the channel.
      if (message.t === "call") {
        const pending = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        pending?.reject(new TypeError(`a value of ${String(message.m)} cannot cross to the other process: ${(error as Error).message}`));
        return;
      }
      if (message.t === "ok") return this.#send({ t: "err", id: message.id, e: this.#encode(new TypeError(`an answer cannot cross to the other process: ${(error as Error).message}`)) });
      return;
    }
    if (body.length > this.#maxFrame) {
      if (message.t === "call") {
        const pending = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        pending?.reject(new RangeError(`a call of ${message.m} is ${body.length} bytes, past the channel's ${this.#maxFrame}`));
        return;
      }
      if (message.t === "ok") return this.#send({ t: "err", id: message.id, e: this.#encode(new RangeError(`an answer of ${body.length} bytes is past the channel's ${this.#maxFrame}`)) });
      return;
    }
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length);
    this.#socket.write(Buffer.concat([head, body]));
  }

  #read(chunk: Buffer): void {
    if (this.#closed) return;
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32BE(0);
      if (length > this.#maxFrame) return this.close(new ChannelClosed(`a frame of ${length} bytes is past the channel's ${this.#maxFrame}`));
      if (this.#buffer.length < 4 + length) return;
      const body = this.#buffer.subarray(4, 4 + length);
      this.#buffer = this.#buffer.subarray(4 + length);
      let message: unknown;
      try {
        message = deserialize(body);
      } catch (error) {
        return this.close(new ChannelClosed(`a frame did not read: ${(error as Error).message}`));
      }
      if (!this.#isMessage(message)) return this.close(new ChannelClosed("a frame is not a message of the channel"));
      this.#handle(message);
    }
  }

  #isMessage(value: unknown): value is Message {
    if (!value || typeof value !== "object") return false;
    const message = value as Record<string, unknown>;
    const id = () => Number.isSafeInteger(message.id);
    const target = () => (typeof message.to === "string" || Number.isSafeInteger(message.to)) && typeof message.m === "string" && Array.isArray(message.a);
    if (message.t === "call") return id() && target();
    if (message.t === "post") return target();
    if (message.t === "ok" || message.t === "err") return id();
    return false;
  }

  #handle(message: Message): void {
    if (message.t === "ok" || message.t === "err") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      let decoded: unknown;
      try {
        decoded = this.#decode(message.t === "ok" ? message.v : message.e);
      } catch (error) {
        return pending.reject(error);
      }
      if (message.t === "ok") pending.resolve(decoded);
      else pending.reject(decoded);
      return;
    }
    if (message.t === "post" && message.m === ABORT && typeof message.to === "number") {
      const signal = this.#signals.get(message.to)?.deref();
      this.#signals.delete(message.to);
      if (signal) this.#controllers.get(signal)?.abort(this.#decodeSafe(message.a[0]));
      return;
    }
    if (message.t === "post" && message.m === RELEASE && typeof message.to === "number") {
      // The other side let go of its stand-in: what this side handed under that handle goes too.
      this.#handles.delete(message.to);
      const handed = this.#handedSignals.get(message.to);
      if (handed) handed.signal.removeEventListener("abort", handed.listener);
      this.#handedSignals.delete(message.to);
      return;
    }
    const run = async (): Promise<unknown> => {
      const args = message.a.map((arg) => this.#decode(arg));
      // Decoded either way, so what it handed is released once collected here.
      const carried = message.t === "call" && message.c !== undefined ? this.#decode(message.c) : undefined;
      if (carried === undefined || !this.#within) return this.#dispatch(message.to, message.m, args);
      return this.#within(carried, () => this.#dispatch(message.to, message.m, args));
    };
    const answered = run();
    if (message.t === "call") {
      answered.then(
        (value) => this.#closed || this.#send({ t: "ok", id: message.id, v: this.#encode(value) }),
        (error: unknown) => this.#closed || this.#send({ t: "err", id: message.id, e: this.#encode(error instanceof Error ? error : new Error(String(error))) }),
      );
    } else answered.catch(() => {});
  }

  #decodeSafe(value: unknown): unknown {
    try {
      return this.#decode(value);
    } catch {
      return undefined;
    }
  }

  #dispatch(to: string | number, method: string, args: unknown[]): unknown {
    if (typeof to === "string") {
      const target = this.#targets.get(to);
      if (!target) throw new ChannelRefused(`no target ${JSON.stringify(to)} on this side of the channel`);
      return target(method, args);
    }
    const handle = this.#handles.get(to);
    if (handle === undefined) throw new ChannelRefused(`no handle ${to} on this side of the channel`);
    if (typeof handle === "function") {
      if (method !== "") throw new ChannelRefused(`handle ${to} is a function`);
      return (handle as (...args: unknown[]) => unknown)(...args);
    }
    const object = handle as { readonly value: object; readonly methods: ReadonlySet<string> };
    if (!object.methods.has(method)) throw new ChannelRefused(`handle ${to} has no method ${JSON.stringify(method)}`);
    return (object.value as Record<string, (...args: unknown[]) => unknown>)[method]!(...args);
  }

  #hand(value: unknown): number {
    const h = this.#next++;
    this.#handles.set(h, value);
    return h;
  }

  #encode(value: unknown, seen = new Set<object>()): unknown {
    if (value === null || typeof value !== "object") {
      if (typeof value === "function") return { [TAG]: "fn", h: this.#hand(value) } satisfies Tagged;
      if (typeof value === "symbol") return undefined;
      return value;
    }
    if (seen.has(value)) throw new TypeError("a value with a cycle cannot cross to the other process");
    seen.add(value);
    try {
      if (value instanceof Error) {
        const fields: Record<string, unknown> = {};
        for (const key of Object.keys(value)) if (key !== "cause") fields[key] = this.#encodeData((value as unknown as Record<string, unknown>)[key]);
        return { [TAG]: "error", name: value.name, message: value.message, ...(value.stack ? { stack: value.stack } : {}), fields } satisfies Tagged;
      }
      if (value instanceof AbortSignal) {
        const h = this.#next++;
        const signal = value;
        if (!signal.aborted) {
          const listener = () => {
            this.#handedSignals.delete(h);
            this.post(h, ABORT, [this.#encodeData(signal.reason)]);
          };
          signal.addEventListener("abort", listener, { once: true });
          this.#handedSignals.set(h, { signal, listener });
        }
        return { [TAG]: "signal", h, aborted: signal.aborted, ...(signal.aborted ? { reason: this.#encodeData(signal.reason) } : {}) } satisfies Tagged;
      }
      if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Date || value instanceof RegExp) return value;
      if (Array.isArray(value)) return value.map((item) => this.#encode(item, seen));
      if (value instanceof Map) return new Map([...value].map(([k, v]) => [this.#encode(k, seen), this.#encode(v, seen)]));
      if (value instanceof Set) return new Set([...value].map((v) => this.#encode(v, seen)));
      if (value instanceof Promise) throw new TypeError("a promise cannot cross to the other process inside a value");
      const data: Record<string, unknown> = {};
      for (const key of Object.keys(value)) {
        const member = (value as Record<string, unknown>)[key];
        if (typeof member === "function" && !isPlain(value)) continue;
        data[key] = this.#encode(member, seen);
      }
      if (isPlain(value) || !hasMethods(value)) return data;
      const methods = methodsOf(value);
      return { [TAG]: "obj", h: this.#hand({ value, methods: new Set(methods) }), data, methods } satisfies Tagged;
    } finally {
      seen.delete(value);
    }
  }

  /** `value` as data alone: an error's fields and an abort's reason never carry a handle. */
  #encodeData(value: unknown): unknown {
    if (value === null || typeof value !== "object") return typeof value === "function" || typeof value === "symbol" ? undefined : value;
    if (value instanceof Error) return { [TAG]: "error", name: value.name, message: value.message, fields: {} } satisfies Tagged;
    try {
      return deserialize(serialize(value));
    } catch {
      return undefined;
    }
  }

  #decode(value: unknown): unknown {
    if (value === null || typeof value !== "object") return value;
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Date || value instanceof RegExp) return value;
    if (Array.isArray(value)) return value.map((item) => this.#decode(item));
    if (value instanceof Map) return new Map([...value].map(([k, v]) => [this.#decode(k), this.#decode(v)]));
    if (value instanceof Set) return new Set([...value].map((v) => this.#decode(v)));
    const tagged = value as Partial<Tagged>;
    const tag = (tagged as Record<string, unknown>)[TAG];
    if (tag === undefined) {
      const out: Record<string, unknown> = {};
      for (const [key, member] of Object.entries(value)) own(out, key, this.#decode(member));
      return out;
    }
    const h = (tagged as { h?: unknown }).h;
    // A handed function's call that nobody awaits (a listener the other side fires and forgets) must not leave an
    // unhandled rejection once the channel closed: the caller that awaits it still gets the error.
    const quiet = (made: Promise<unknown>): Promise<unknown> => {
      made.catch(() => undefined);
      return made;
    };
    if (tag === "fn" && Number.isSafeInteger(h)) {
      const fn = (...args: unknown[]) => quiet(this.call(h as number, "", args));
      // Once nothing here holds the stand-in, the other side lets go of the function.
      this.#released.register(fn, h as number);
      return fn;
    }
    if (tag === "obj" && Number.isSafeInteger(h)) {
      const { data, methods } = tagged as { data?: unknown; methods?: unknown };
      if (!data || typeof data !== "object" || !Array.isArray(methods)) throw new ChannelRefused("a handed object is not one");
      const out = this.#decode(data) as Record<string, unknown>;
      // One token every method holds: the object is let go of once neither it nor any of its methods is held here.
      const kept = {};
      for (const name of methods) if (typeof name === "string") own(out, name, (...args: unknown[]) => (void kept, quiet(this.call(h as number, name, args))));
      this.#released.register(kept, h as number);
      return out;
    }
    if (tag === "signal" && Number.isSafeInteger(h)) {
      const controller = new AbortController();
      const { aborted, reason } = tagged as { aborted?: unknown; reason?: unknown };
      if (aborted) controller.abort(this.#decode(reason));
      else {
        this.#controllers.set(controller.signal, controller);
        this.#signals.set(h as number, new WeakRef(controller.signal));
        this.#released.register(controller.signal, h as number);
      }
      return controller.signal;
    }
    if (tag === "error") {
      const { name, message, stack, fields } = tagged as { name?: unknown; message?: unknown; stack?: unknown; fields?: unknown };
      const type = typeof name === "string" ? ERRORS.get(name) : undefined;
      const error = (type ? Object.create(type.prototype) : new Error()) as Error;
      Object.defineProperty(error, "message", { value: String(message ?? ""), writable: true, configurable: true });
      Object.defineProperty(error, "name", { value: typeof name === "string" ? name : "Error", writable: true, configurable: true });
      if (typeof stack === "string") Object.defineProperty(error, "stack", { value: stack, writable: true, configurable: true });
      if (fields && typeof fields === "object") for (const [key, member] of Object.entries(fields)) own(error as unknown as Record<string, unknown>, key, this.#decode(member));
      return error;
    }
    throw new ChannelRefused("a value carries a tag the channel does not know");
  }
}

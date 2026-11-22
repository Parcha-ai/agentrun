/** A moved project's capabilities exported to a child process. Closing denies new calls through retained handles;
 * draining waits for the actual dispatched promises, even if their cancellation has already been requested. */
import { ClaimRefused } from "./loop-contract.js";

export class ProjectHostGate {
  #closed = false;
  #active = new Set<Promise<unknown>>();
  #wrapped = new WeakMap<object, object>();
  #uncertain = false;
  get uncertain(): boolean { return this.#uncertain; }
  close(): void { this.#closed = true; }
  async drain(): Promise<void> { await Promise.allSettled([...this.#active]); }
  async run<T>(work: () => T | Promise<T>, writes = true): Promise<T> {
    if (this.#closed) throw new ClaimRefused("The project's dispatch has closed for checkpoint capture.");
    const pending = Promise.resolve().then(work); this.#active.add(pending);
    try { return await pending; } catch (error) { if (writes) this.#uncertain = true; throw error; }
    finally { this.#active.delete(pending); }
  }
  /** Recursively cover returned callable handles too (Workspace.attach, computer clients, and Pieces.write).
   * Data stays data; methods retain their original receiver so backend private fields remain valid. */
  capability<T extends object>(value: T): T {
    if (value instanceof AbortSignal || value instanceof Date || ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Map || value instanceof Set) return value;
    if (Array.isArray(value)) return value.map(item => item && typeof item === "object" ? this.capability(item) : item) as T;
    const existing = this.#wrapped.get(value); if (existing) return existing as T;
    const wrapped = new Proxy(value, { get: (target, key) => {
      const member = Reflect.get(target, key, target);
      if (typeof member === "function") return (...args: unknown[]) => this.run(async () => {
        const answer: unknown = await Reflect.apply(member, target, args);
        return answer && typeof answer === "object" ? this.capability(answer) : answer;
      }, !["read", "stat", "list", "grep", "readBack", "readBackOf", "wait"].includes(String(key))
        && !(key === "call" && typeof args[0] === "string" && ["hello", "files.read", "files.stat", "files.list", "process.read", "process.list", "process.wait"].includes(args[0])));
      return member && typeof member === "object" ? this.capability(member) : member;
    } });
    this.#wrapped.set(value, wrapped); return wrapped;
  }
}

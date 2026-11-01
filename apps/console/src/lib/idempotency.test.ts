import { describe, expect, it } from "vitest";
import { appendRuns, keeper, sendOnce, uuid } from "./idempotency";

describe("keeper", () => {
  it("keeps one key per request: the same request again reuses it, a changed one gets a new one", () => {
    let n = 0;
    const keys = keeper(() => `k${++n}`);
    expect(keys.keyFor("r1", { content: "Go." })).toBe("k1");
    expect(keys.keyFor("r1", { content: "Go." })).toBe("k1");
    expect(keys.keyFor("r1", { content: "Stop." })).toBe("k2");
    keys.done();
    expect(keys.keyFor("r1", { content: "Stop." })).toBe("k3");
  });
});

describe("sendOnce", () => {
  it("a message whose answer was lost or refused is resent under the same key, so the server does not take it twice", async () => {
    let n = 0;
    const keys = keeper(() => `k${++n}`);
    const sent: string[] = [];
    const fail = async (_r: string, _c: string, key: string) => { sent.push(key); throw new Error("lost"); };
    await sendOnce(keys, "r1", "Use EUR.", fail).catch(() => {});
    await sendOnce(keys, "r1", "Use EUR.", fail).catch(() => {});
    expect(sent).toEqual(["k1", "k1"]);
  });
  it("after the server took it, the next message is new work under a new key", async () => {
    let n = 0;
    const keys = keeper(() => `k${++n}`);
    const sent: string[] = [];
    const ok = async (_r: string, _c: string, key: string) => { sent.push(key); return { mode: "follow_up" }; };
    await sendOnce(keys, "r1", "Use EUR.", ok);
    await sendOnce(keys, "r1", "Use EUR.", ok);
    expect(sent).toEqual(["k1", "k2"]);
  });
});

describe("appendRuns", () => {
  it("adds the next page's runs once: a run the offset cursor sends again is not repeated", () => {
    const r = (id: string) => ({ run_id: id }) as never;
    expect(appendRuns([r("a"), r("b")], [r("b"), r("c")]).map((x: { run_id: string }) => x.run_id)).toEqual(["a", "b", "c"]);
  });
});

describe("uuid", () => {
  it("makes a v4 UUID without crypto.randomUUID, as on a plain-http host", () => {
    const real = crypto.randomUUID;
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    try { expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); }
    finally { Object.defineProperty(crypto, "randomUUID", { value: real, configurable: true }); }
  });
});

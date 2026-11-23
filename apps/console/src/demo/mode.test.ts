import { expect, it, vi } from "vitest";
import { ClientError } from "@/lib/client";
import { DEMO_REFUSAL, demoOn, demoUpload, onDemoChange, setDemo } from "./mode";

const store = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }; };

it("keeps the choice in this browser, and tells the page of each change", () => {
  const s = store();
  const heard = vi.fn();
  const stop = onDemoChange(heard);
  expect(demoOn(s)).toBe(false);
  setDemo(true, s);
  expect(demoOn(s)).toBe(true);
  expect(s.getItem("agentrun.console.demo")).toBe("on");
  setDemo(false, s);
  expect(demoOn(s)).toBe(false);
  expect(s.getItem("agentrun.console.demo")).toBeNull();
  expect(heard.mock.calls).toEqual([[true], [false]]);
  stop();
  setDemo(true, s);
  expect(heard).toHaveBeenCalledTimes(2);
  setDemo(false, s);
});

it("holds the choice on the page when the browser's storage refuses it", () => {
  const refusing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
  setDemo(true, refusing);
  expect(demoOn(refusing)).toBe(true);
  setDemo(false, refusing);
  expect(demoOn(refusing)).toBe(false);
  setDemo(false, store());
});

it("refuses a picked file in the page: no request is made, and the person reads why", async () => {
  const open = vi.spyOn(XMLHttpRequest.prototype, "open");
  const sent = vi.spyOn(globalThis, "fetch");
  const refusal = await demoUpload(new File(["x"], "notes.md"), () => {}, new AbortController().signal).catch((e: unknown) => e);
  expect(refusal).toBeInstanceOf(ClientError);
  expect(refusal).toMatchObject({ status: 403, code: "demo_mode", message: DEMO_REFUSAL });
  expect(open).not.toHaveBeenCalled();
  expect(sent).not.toHaveBeenCalled();
  open.mockRestore();
  sent.mockRestore();
});

import { expect, it, vi } from "vitest";
import { ClientError } from "@/lib/client";
import { demoOn, demoUpload, onDemoChange, setDemo } from "./mode";

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

it("keeps a picked file in the page, as an upload the server took, and sends no request", async () => {
  const open = vi.spyOn(XMLHttpRequest.prototype, "open");
  const sent = vi.spyOn(globalThis, "fetch");
  const progress: number[] = [];
  const file = await demoUpload(new File(["# Notes\n"], "notes.md", { type: "text/markdown" }), (f) => progress.push(f), new AbortController().signal);
  expect(file).toMatchObject({ path: "notes.md", size_bytes: 8, content_type: "text/markdown", status: "ready" });
  expect(file.file_id).toMatch(/^file_demo_/);
  expect(progress.at(-1)).toBe(1);
  expect(open).not.toHaveBeenCalled();
  expect(sent).not.toHaveBeenCalled();
  open.mockRestore();
  sent.mockRestore();
});

it("stops a picked file's upload when its picker lets go of it", async () => {
  const stop = new AbortController();
  const going = demoUpload(new File(["x"], "x.md"), () => {}, stop.signal);
  stop.abort();
  await expect(going).rejects.toBeInstanceOf(ClientError);
});

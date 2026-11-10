import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { FilePicker, type UploadLimits, useAttachments } from "./FilePicker";
import { ClientError } from "@/lib/client";
import type { Upload, UploadedFile } from "@/lib/uploads";

// The start screens' file picker: picked files are sent at once and in parallel, each a chip with its size and progress,
// named by the run once sent; the server's limits are said and kept before anything is sent; a refusal is said in the
// server's words; a removed file is stopped, or deleted from the server once it was sent.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

type Pending = { file: File; progress: (f: number) => void; signal: AbortSignal; resolve: (f: UploadedFile) => void; reject: (e: unknown) => void };
const made = (name: string, n: number): UploadedFile => ({ file_id: `019a0000-0000-7000-8000-00000000000${n}`, path: name, size_bytes: 3, content_type: "text/plain", sha256: "a".repeat(64), status: "ready", created_at: "2026-11-01T09:00:00Z", expires_at: null });

function open(limits: UploadLimits = {}) {
  const pending: Pending[] = [];
  const removed: string[] = [];
  const upload: Upload = (file, progress, signal) => new Promise((resolve, reject) => { pending.push({ file, progress, signal, resolve, reject }); });
  const remove = async (id: string) => { removed.push(id); };
  let state: ReturnType<typeof useAttachments> | undefined;
  function Harness() {
    state = useAttachments({ upload, remove, limits });
    return createElement(FilePicker, { attachments: state, limits });
  }
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(Harness)));
  const pick = (...files: File[]) => act(() => {
    const input = host.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { value: files, configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const settle = async (fn: () => void) => { await act(async () => { fn(); await Promise.resolve(); }); };
  return { host, pending, removed, pick, settle, state: () => state!, text: () => host.textContent ?? "" };
}
const file = (name: string, size = 3) => new File(["x".repeat(size)], name, { type: "text/plain" });

describe("FilePicker", () => {
  it("sends every picked file at once, shows each with its size and progress, and names them once sent, in pick order", async () => {
    const page = open({ max_upload_bytes: 50 * 2 ** 20, max_files_per_run: 20 });
    expect(page.text()).toContain("up to 20 files, 50.0 MB each");
    page.pick(file("a.txt"), file("b.txt", 2048));
    expect(page.pending.map((p) => p.file.name)).toEqual(["a.txt", "b.txt"]);
    expect(page.state().busy).toBe(true);
    await page.settle(() => page.pending[1]!.progress(0.4));
    expect(page.text()).toContain("b.txt2.0 KB40%");
    await page.settle(() => page.pending[1]!.resolve(made("b.txt", 2)));
    await page.settle(() => page.pending[0]!.resolve(made("a.txt", 1)));
    expect(page.state().fileIds).toEqual([made("a.txt", 1).file_id, made("b.txt", 2).file_id]);
    expect(page.state().busy).toBe(false);
  });

  it("refuses a file over the largest upload and one past the most files a run names, before sending either", () => {
    const page = open({ max_upload_bytes: 10, max_files_per_run: 2 });
    page.pick(file("big.bin", 11), file("one.txt"), file("two.txt"), file("three.txt"));
    expect(page.pending.map((p) => p.file.name)).toEqual(["one.txt", "two.txt"]);
    expect(page.text()).toContain("big.bin is 11 B: this server takes files up to 10 B.");
    expect(page.text()).toContain("three.txt is not added: a run names at most 2 files here.");
  });

  it("takes a null largest upload as no limit: a file of any size is sent, and no size is said", () => {
    const page = open({ max_upload_bytes: null, max_files_per_run: 20 });
    expect(page.text()).toContain("up to 20 files");
    expect(page.text()).not.toMatch(/\bB each\b|takes files up to/);
    page.pick(file("big.bin", 4096), file("one.txt"));
    expect(page.pending.map((p) => p.file.name)).toEqual(["big.bin", "one.txt"]);
    expect(page.text()).not.toContain("takes files up to");
  });

  it("says a refusal the server gives in its words, with the file's name, and drops the file", async () => {
    const page = open();
    page.pick(file("notes.md"));
    await page.settle(() => page.pending[0]!.reject(new ClientError(400, "invalid_file_path", "A path may not start with a dot.")));
    expect(page.text()).toContain("notes.md: A path may not start with a dot.");
    expect(page.host.querySelector('[aria-label="Attached files"]')).toBeNull();
    expect(page.state().fileIds).toEqual([]);
  });

  it("deletes a sent file the person removes, and stops one still sending (deleting it too if it lands after)", async () => {
    const page = open();
    page.pick(file("a.txt"), file("b.txt"));
    await page.settle(() => page.pending[0]!.resolve(made("a.txt", 1)));
    await page.settle(() => (page.host.querySelector('[aria-label="Remove a.txt"]') as HTMLButtonElement).click());
    expect(page.removed).toEqual([made("a.txt", 1).file_id]);
    await page.settle(() => (page.host.querySelector('[aria-label="Remove b.txt"]') as HTMLButtonElement).click());
    expect(page.pending[1]!.signal.aborted).toBe(true);
    await page.settle(() => page.pending[1]!.resolve(made("b.txt", 2)));
    expect(page.removed).toEqual([made("a.txt", 1).file_id, made("b.txt", 2).file_id]);
    expect(page.state().fileIds).toEqual([]);
    expect(page.state().busy).toBe(false);
  });

  it("takes files dropped on it", () => {
    const page = open();
    act(() => {
      const zone = page.host.querySelector('[aria-label="Files for the run"]')!;
      const drop = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(drop, "dataTransfer", { value: { files: [file("dropped.csv")] } });
      zone.dispatchEvent(drop);
    });
    expect(page.pending.map((p) => p.file.name)).toEqual(["dropped.csv"]);
  });
});

// A start under way freezes the picker; a screen left with sent files nobody ran deletes them; a delete that fails keeps
// the file on the page, says so, and Remove tries again.
describe("FilePicker, the files' lives", () => {
  function mount({ remove }: { remove?: (id: string) => Promise<unknown> } = {}) {
    const pending: Pending[] = [];
    const removed: string[] = [];
    const upload: Upload = (f, progress, signal) => new Promise((resolve, reject) => { pending.push({ file: f, progress, signal, resolve, reject }); });
    // Each delete asked is recorded; `remove`, when given, answers it (and may refuse).
    const del = async (id: string) => { removed.push(id); if (remove) await remove(id); };
    let state: ReturnType<typeof useAttachments> | undefined;
    function Harness({ frozen }: { frozen: boolean }) {
      state = useAttachments({ upload, remove: del, frozen });
      return createElement(FilePicker, { attachments: state });
    }
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    const show = (frozen = false) => act(() => root!.render(createElement(Harness, { frozen })));
    show();
    const pick = (...files: File[]) => act(() => {
      const input = host.querySelector('input[type="file"]') as HTMLInputElement;
      Object.defineProperty(input, "files", { value: files, configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const settle = async (fn: () => void) => { await act(async () => { fn(); await Promise.resolve(); await Promise.resolve(); }); };
    const removeBtn = (name: string) => host.querySelector(`[aria-label="Remove ${name}"]`) as HTMLButtonElement | null;
    const attach = () => [...host.querySelectorAll("button")].find((b) => /Attach files/.test(b.textContent ?? "")) as HTMLButtonElement;
    const leave = () => { act(() => root!.unmount()); root = undefined; };
    return { host, pending, removed, show, pick, settle, removeBtn, attach, leave, state: () => state!, text: () => host.textContent ?? "" };
  }

  it("takes no change while a start is under way, and keeps the start's files when the screen goes then", async () => {
    const page = mount();
    page.pick(file("a.txt"));
    await page.settle(() => page.pending[0]!.resolve(made("a.txt", 1)));
    page.show(true);
    expect(page.attach().disabled).toBe(true);
    expect(page.removeBtn("a.txt")!.disabled).toBe(true);
    page.state().drop(page.state().items[0]!.key);
    page.state().add([file("late.txt")]);
    expect(page.pending).toHaveLength(1);
    expect(page.state().fileIds).toEqual([made("a.txt", 1).file_id]);
    page.leave();
    expect(page.removed).toEqual([]);
  });

  it("deletes the sent files no run named when the screen goes away, and never those a run started with", async () => {
    const left = mount();
    left.pick(file("a.txt"));
    await left.settle(() => left.pending[0]!.resolve(made("a.txt", 1)));
    left.leave();
    expect(left.removed).toEqual([made("a.txt", 1).file_id]);
    const ran = mount();
    ran.pick(file("b.txt"));
    await ran.settle(() => ran.pending[0]!.resolve(made("b.txt", 2)));
    // The run started with it: the screen forgets the file and goes in the same tick.
    act(() => { ran.state().clear(); root!.unmount(); });
    root = undefined;
    expect(ran.removed).toEqual([]);
  });

  it("keeps a file whose delete fails, says so, and deletes it when Remove is tried again", async () => {
    let tries = 0;
    const page = mount({ remove: async () => { if (++tries === 1) throw new ClientError(0, "network", "The request did not reach the server."); } });
    page.pick(file("a.txt"));
    await page.settle(() => page.pending[0]!.resolve(made("a.txt", 1)));
    await page.settle(() => page.removeBtn("a.txt")!.click());
    expect(page.removeBtn("a.txt")).not.toBeNull();
    expect(page.text()).toContain("a.txt was not removed: The request did not reach the server.");
    expect(page.state().fileIds).toEqual([made("a.txt", 1).file_id]);
    await page.settle(() => page.removeBtn("a.txt")!.click());
    expect(page.removeBtn("a.txt")).toBeNull();
    expect(page.text()).not.toContain("was not removed");
    expect(page.state().fileIds).toEqual([]);
  });

  it("says when a file that landed after it was stopped could not be deleted", async () => {
    const page = mount({ remove: async () => { throw new ClientError(401, "unauthenticated", "Sign in again."); } });
    page.pick(file("b.txt"));
    await page.settle(() => page.removeBtn("b.txt")!.click());
    await page.settle(() => page.pending[0]!.resolve(made("b.txt", 2)));
    expect(page.text()).toContain("b.txt was sent before it was stopped, and was not removed: Sign in again.");
  });

  it("says, while a file is sent, that the run can start once every file is sent", async () => {
    const page = mount();
    page.pick(file("a.txt"));
    expect(page.text()).toContain("The run can start once every file is sent.");
    await page.settle(() => page.pending[0]!.resolve(made("a.txt", 1)));
    expect(page.text()).not.toContain("once every file is sent");
  });
});

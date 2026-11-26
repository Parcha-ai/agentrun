import { describe, expect, it } from "vitest";
import { computerFields, pickKind, runnerShellOf } from "./computers";
import type { Computer, ComputerKindView } from "./v2";

// A switch of a computer's kind or provider carries what the old one set where the new one takes it, and says what it
// drops. A sandbox's needs (the programs its box must have) are the sandbox's whichever provider serves it: a switch to
// another sandbox provider keeps them, a switch to a desktop drops them in words, never silently.
const provider = (id: string, name: string) => ({ id, name, ready: true, keys: [] });
const kind = (name: string, settings: string[], providers: ReturnType<typeof provider>[]) =>
  ({ kind: name, offered: true, groups: [], tools: [], settings, record: { available: false }, providers }) as unknown as ComputerKindView;
const SANDBOX = kind("sandbox", ["image", "gpu", "persistent", "needs"], [provider("docker", "Docker"), provider("daytona", "Daytona")]);
const DESKTOP = kind("desktop", ["image", "persistent", "surface", "exec", "record"], [provider("orgo", "Orgo")]);
const MEDIA = ["chrome", "ffmpeg", "ffprobe", "hyperframes"];

describe("a sandbox's needs across a switch", () => {
  it("another sandbox provider keeps them", () => {
    const current = { kind: "sandbox", provider: "docker", needs: MEDIA } as Computer;
    const sandboxOnDaytona = { ...SANDBOX, providers: [provider("daytona", "Daytona")] } as unknown as ComputerKindView;
    const { computer, dropped } = pickKind(sandboxOnDaytona, current);
    expect(computer).toEqual({ kind: "sandbox", provider: "daytona", needs: MEDIA });
    expect(dropped).toEqual({});
  });

  it("a desktop drops them and says so", () => {
    const current = { kind: "sandbox", provider: "docker", needs: MEDIA } as Computer;
    const { computer, dropped } = pickKind(DESKTOP, current);
    expect(computer).toEqual({ kind: "desktop", provider: "orgo" });
    expect(dropped).toEqual({ needs: MEDIA });
  });
});

// The edit that puts an agent on a computer drops, on the runner, the tools the capabilities mark sandbox_only. With none
// listed (not read yet, or their read failed) which those are is unknown: an edit to the runner of an agent with tools
// is null, never one that keeps them all.
describe("computerFields with no tools listed", () => {
  const OFFERED = [{ name: "bash", sandbox_only: true as const }, { name: "read" }];
  it("the runner, tools listed: drops the box-only ones", () => {
    expect(computerFields({ kind: "none" }, ["bash", "read"], OFFERED, null)).toEqual({ computer: { kind: "none" }, place: { mode: "runner" }, tools: ["read"] });
  });
  it("the runner, no tools listed, an agent with tools: null", () => {
    expect(computerFields({ kind: "none" }, ["bash", "read"], [], null)).toBeNull();
  });
  it("no tools listed, but nothing to drop: an agent with no tools on the runner, or a pick of a box", () => {
    expect(computerFields({ kind: "none" }, [], [], null)).toEqual({ computer: { kind: "none" }, place: { mode: "runner" }, tools: [] });
    expect(computerFields({ kind: "sandbox", provider: "docker" }, ["bash", "read"], [], null)).toEqual({ computer: { kind: "sandbox", provider: "docker" }, place: { mode: "sandbox", box: "docker" } });
  });
});

// The server lets a box-only tool on a runner place only where the run's shell is the runner's own (runnable.ts:
// runShellOf "local"), which GET /v2/computers serves as each choice's `shell`: the no-computer choice's own, else the
// provider's. Mode 2: no computer's shell is Archil's exec ("local"), which runs bash; the background tools still need a
// box. Mode 1: no computer has no shell ("none"), so a move there drops every box-only tool, as does a list not read.
describe("computerFields to the runner, by the choice's served shell", () => {
  const OFFERED = [{ name: "bash", sandbox_only: true as const }, { name: "bash_background", sandbox_only: true as const }, { name: "read" }];
  const none = (shell: string) => ({ kind: "none", providers: [], shell });
  const served = (...kinds: unknown[]) => kinds as ComputerKindView[];
  const TOOLS = ["bash", "bash_background", "read"];
  it("Mode 2 (no computer's shell \"local\"): keeps bash, drops the background tools", () => {
    expect(computerFields({ kind: "none" }, TOOLS, OFFERED, served(none("local")))).toEqual({ computer: { kind: "none" }, place: { mode: "runner" }, tools: ["bash", "read"] });
  });
  it("Mode 1 (no computer's shell \"none\"), a list not read, or one with no such choice: drops bash too", () => {
    for (const kinds of [served(none("none")), null, served()]) {
      expect(computerFields({ kind: "none" }, TOOLS, OFFERED, kinds)).toEqual({ computer: { kind: "none" }, place: { mode: "runner" }, tools: ["read"] });
    }
  });
  // Another kind on a runner place keeps bash only where its provider's served run shell is the runner's own: a desktop
  // that mounts the run's folder ("computer"), one with no shell, and one whose provider isn't listed drop it.
  it("Mode 2, a desktop: keeps bash only where its run shell is the runner's own", () => {
    const desktop = (shell: string) => served(none("local"), { kind: "desktop", providers: [{ id: "e2b", shell }] });
    const fields = (kinds: ComputerKindView[] | null) => computerFields({ kind: "desktop", provider: "e2b" }, ["bash", "read"], OFFERED, kinds);
    expect(fields(desktop("local"))?.tools).toEqual(["bash", "read"]);
    for (const kinds of [desktop("computer"), desktop("none"), served(none("local")), null]) expect(fields(kinds)?.tools).toEqual(["read"]);
  });
  // serve's runShellOf: a computer that runs no programs of its own (exec: false) has no shell anywhere, not its
  // computer's and not Archil's exec, whatever its provider's served shell.
  it("Mode 2, a desktop or phone set to run no programs (exec: false): no shell tools, though its provider's shell is the runner's own", () => {
    const kinds = served(none("local"), { kind: "desktop", providers: [{ id: "e2b", shell: "local" }] }, { kind: "phone", providers: [{ id: "orgo", shell: "local" }] });
    for (const computer of [{ kind: "desktop", provider: "e2b", exec: false }, { kind: "phone", provider: "orgo", exec: false }] as Computer[]) {
      expect([...runnerShellOf(computer, kinds)], computer.kind).toEqual([]);
      expect(computerFields(computer, ["bash", "read"], OFFERED, kinds)?.tools, computer.kind).toEqual(["read"]);
    }
    expect([...runnerShellOf({ kind: "desktop", provider: "e2b", exec: true } as Computer, kinds)]).toEqual(["bash"]);
  });
});

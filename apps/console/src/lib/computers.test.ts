import { describe, expect, it } from "vitest";
import { computerFields, pickKind } from "./computers";
import type { Places } from "./place";
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

// Mode 2: the runner has a shell (Archil's serverless exec), which capabilities say by serving the runner as a new
// agent's default place. It runs bash, so a move to the runner keeps bash; the background tools still need a box. Mode 1:
// the runner has no shell, so a move there drops every box-only tool.
describe("computerFields to the runner, by mode", () => {
  const OFFERED = [{ name: "bash", sandbox_only: true as const }, { name: "bash_background", sandbox_only: true as const }, { name: "read" }];
  const MODE2: Places = { modes: ["runner", "sandbox"], boxes: [{ id: "modal", available: true }], defaultPlace: { mode: "runner" } };
  const MODE1: Places = { modes: ["runner", "sandbox"], boxes: [{ id: "docker", available: true }], defaultPlace: { mode: "sandbox", box: "docker" } };
  const MODE1_NO_BOX: Places = { modes: ["runner", "sandbox"], boxes: [], defaultPlace: null };
  it("Mode 2: keeps bash, drops the background tools", () => {
    expect(computerFields({ kind: "none" }, ["bash", "bash_background", "read"], OFFERED, MODE2)).toEqual({ computer: { kind: "none" }, place: { mode: "runner" }, tools: ["bash", "read"] });
  });
  it("Mode 1: drops bash too, with a Docker box or with none", () => {
    for (const places of [MODE1, MODE1_NO_BOX, null]) {
      expect(computerFields({ kind: "none" }, ["bash", "bash_background", "read"], OFFERED, places)).toEqual({ computer: { kind: "none" }, place: { mode: "runner" }, tools: ["read"] });
    }
  });
});

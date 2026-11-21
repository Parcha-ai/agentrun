import { describe, expect, it } from "vitest";
import { pickKind } from "./computers";
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
    const sandboxOnDaytona = { ...SANDBOX, providers: [provider("daytona", "Daytona")] } as ComputerKindView;
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

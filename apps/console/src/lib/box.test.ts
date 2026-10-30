import { describe, expect, it } from "vitest";
import { boxLine, boxNotice, nativeTools } from "./box";

// capabilities.box (box/1): what runs a run's native tools here. The console keys on mode and error, never on detail,
// shows detail as the server's own words, and never says tools run where no harness offers native tools.
const off = [{ id: "pi", native_tools: false }, { id: "codex", native_tools: false }];
const on = [{ id: "pi", native_tools: false }, { id: "codex", native_tools: true }];

describe("nativeTools: whether native tools run here", () => {
  it("is any harness's flag, or one harness's", () => {
    expect(nativeTools(off)).toBe(false);
    expect(nativeTools(on)).toBe(true);
    expect(nativeTools(on, "codex")).toBe(true);
    expect(nativeTools(on, "pi")).toBe(false);
    expect(nativeTools(undefined)).toBe(false);
  });
});

describe("boxNotice: the banner a person sees before they file a bug", () => {
  it("says native tools are off, in the server's words, when there's no box", () => {
    const n = boxNotice({ mode: "unavailable", cgroup: false, egress: "open", error: "bwrap_userns_denied", detail: "run `agentrun-box install` once as root, then restart the server." }, false);
    expect(n?.tone).toBe("error");
    expect(n?.text).toBe("Native tools are off on this server: run `agentrun-box install` once as root, then restart the server.");
  });
  it("warns when the operator chose to run native tools with no box, only where a harness runs them", () => {
    expect(boxNotice({ mode: "unsandboxed", cgroup: false, egress: "open" }, true)).toEqual({ tone: "warning", text: "Native tools run with no sandbox on this server: its operator chose it." });
    expect(boxNotice({ mode: "unsandboxed", cgroup: false, egress: "open" }, false)).toBeNull();
  });
  it("says nothing when a box runs them, or when an older server says nothing about it", () => {
    for (const mode of ["bwrap", "seatbelt", "provider"] as const) expect(boxNotice({ mode, cgroup: true, egress: "open" }, true)).toBeNull();
    expect(boxNotice(undefined, true)).toBeNull();
  });
});

describe("boxLine: where tools run, on the agent's Tools step", () => {
  it("names the box and where it may reach, when the harness runs native tools", () => {
    expect(boxLine({ mode: "bwrap", cgroup: true, egress: "open" }, true)).toBe("Tools run in a bwrap sandbox · network open");
    expect(boxLine({ mode: "seatbelt", cgroup: false, egress: "open" }, true)).toBe("Tools run in a macOS sandbox (seatbelt) · network open");
    expect(boxLine({ mode: "provider", cgroup: false, egress: "open" }, true)).toBe("Tools run in the provider's sandbox · network open");
    expect(boxLine({ mode: "unsandboxed", cgroup: false, egress: "open" }, true)).toBe("Tools run with no sandbox · network open");
  });
  it("claims nothing where no harness offers native tools, whatever the box", () => {
    for (const mode of ["bwrap", "seatbelt", "provider", "unsandboxed"] as const) expect(boxLine({ mode, cgroup: true, egress: "open" }, false)).toBeNull();
  });
  it("says native tools are off when there's no box, and nothing for no box field or a mode it doesn't know", () => {
    expect(boxLine({ mode: "unavailable", cgroup: false, egress: "open", error: "box_probe_failed", detail: "x" }, false)).toBe("Native tools are off on this server");
    expect(boxLine(undefined, true)).toBeNull();
    expect(boxLine({ mode: "microvm" as never, cgroup: false, egress: "open" }, true)).toBeNull();
  });
});

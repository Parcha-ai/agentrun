import { describe, expect, it } from "vitest";
import { boxLine, boxNotice } from "./box";

// capabilities.box (box/1): what runs a run's native tools here. The console keys on mode and error, never on detail,
// and shows detail as the server's own words.
describe("boxNotice: the banner a person sees before they file a bug", () => {
  it("says native tools are off, in the server's words, when there's no box", () => {
    const n = boxNotice({ mode: "unavailable", cgroup: false, egress: "open", error: "bwrap_userns_denied", detail: "run `agentrun-box install` once as root, then restart the server." });
    expect(n?.tone).toBe("error");
    expect(n?.text).toBe("Native tools are off on this server: run `agentrun-box install` once as root, then restart the server.");
  });
  it("warns when the operator chose to run tools with no box", () => {
    expect(boxNotice({ mode: "unsandboxed", cgroup: false, egress: "open" })).toEqual({ tone: "warning", text: "Native tools run with no sandbox on this server: its operator chose it." });
  });
  it("says nothing when a box runs them, or when an older server says nothing about it", () => {
    for (const mode of ["bwrap", "seatbelt", "provider"] as const) expect(boxNotice({ mode, cgroup: true, egress: "open" })).toBeNull();
    expect(boxNotice(undefined)).toBeNull();
  });
});

describe("boxLine: where tools run, on the agent's Tools step", () => {
  it("names the box and where it may reach", () => {
    expect(boxLine({ mode: "bwrap", cgroup: true, egress: "open" })).toBe("Tools run in a bwrap sandbox · network open");
    expect(boxLine({ mode: "seatbelt", cgroup: false, egress: "open" })).toBe("Tools run in a macOS sandbox (seatbelt) · network open");
    expect(boxLine({ mode: "provider", cgroup: false, egress: "open" })).toBe("Tools run in the provider's sandbox · network open");
    expect(boxLine({ mode: "unsandboxed", cgroup: false, egress: "open" })).toBe("Tools run with no sandbox · network open");
    expect(boxLine({ mode: "unavailable", cgroup: false, egress: "open", error: "box_probe_failed", detail: "x" })).toBe("Native tools are off on this server");
    expect(boxLine(undefined)).toBeNull();
  });
});

/** `capabilities.box` (a serve extension, box/1): what runs a run's native tools on this server. `error` and `detail`
 *  are there only when `mode` is `unavailable`: `error` is a stable code, `detail` the server's own words. The console
 *  keys on `mode` and `error`, and shows `detail` as it is, never parsing it. */
export type Box = {
  mode: "bwrap" | "seatbelt" | "provider" | "unsandboxed" | "unavailable";
  cgroup: boolean;
  egress: "open";
  error?: string;
  detail?: string;
};

/** Whether native tools run here (`capabilities.harnesses[].native_tools`): one harness's flag, or any harness's. A box
 *  says where they would run; this says whether they do, so nothing claims tools run where no harness offers them. */
export function nativeTools(harnesses: { id: string; native_tools?: boolean }[] | undefined, harness?: string): boolean {
  return (harnesses ?? []).some((h) => h.native_tools === true && (harness === undefined || h.id === harness));
}

/** The console-wide notice a box asks for: native tools off (and why, in the server's words); or, where a harness runs
 *  native tools, running with no box by the operator's choice. A working box, or no box field, asks for none. */
export function boxNotice(box: Box | undefined, native: boolean): { tone: "error" | "warning"; text: string } | null {
  if (!box) return null;
  if (box.mode === "unavailable") return { tone: "error", text: `Native tools are off on this server: ${box.detail ?? "its box is unavailable."}` };
  if (box.mode === "unsandboxed" && native) return { tone: "warning", text: "Native tools run with no sandbox on this server: its operator chose it." };
  return null;
}

const WHERE: Partial<Record<string, string>> = {
  bwrap: "in a bwrap sandbox",
  seatbelt: "in a macOS sandbox (seatbelt)",
  provider: "in the provider's sandbox",
  unsandboxed: "with no sandbox",
};

/** Where an agent's tools run, for the Tools step: that native tools are off, or, where its harness runs them, the box
 *  and where it may reach. A mode this console doesn't know (a later box version) says nothing. */
export function boxLine(box: Box | undefined, native: boolean): string | null {
  if (!box) return null;
  if (box.mode === "unavailable") return "Native tools are off on this server";
  const where = WHERE[box.mode];
  return native && where ? `Tools run ${where} · network ${box.egress}` : null;
}

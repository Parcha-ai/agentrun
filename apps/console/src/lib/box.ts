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

/** The console-wide notice a box asks for: native tools off (and why, in the server's words), or running with no box
 *  by the operator's choice. A working box, or a server that says nothing about one, asks for none. */
export function boxNotice(box: Box | undefined): { tone: "error" | "warning"; text: string } | null {
  if (!box) return null;
  if (box.mode === "unavailable") return { tone: "error", text: `Native tools are off on this server: ${box.detail ?? "its box is unavailable."}` };
  if (box.mode === "unsandboxed") return { tone: "warning", text: "Native tools run with no sandbox on this server: its operator chose it." };
  return null;
}

const WHERE: Record<Exclude<Box["mode"], "unavailable">, string> = {
  bwrap: "in a bwrap sandbox",
  seatbelt: "in a macOS sandbox (seatbelt)",
  provider: "in the provider's sandbox",
  unsandboxed: "with no sandbox",
};

/** Where an agent's tools run, for the Tools step: the box and where it may reach, or that native tools are off. */
export function boxLine(box: Box | undefined): string | null {
  if (!box) return null;
  if (box.mode === "unavailable") return "Native tools are off on this server";
  return `Tools run ${WHERE[box.mode]} · network ${box.egress}`;
}

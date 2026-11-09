// An agent's approvals (definition.approvals): "ask", the default, is the tool gate as its settings say; "never" runs
// the agent unattended, a tool that would ask allowed instead (tool-gate.ts permissionFrom's last step, after every
// refusal). A module of its own, with no imports, so the definition's check (validate.ts), the gate and the template
// reader take it from one place.
export const APPROVALS = ["ask", "never"] as const;
export type Approvals = (typeof APPROVALS)[number];
/** The approvals a stored body or a definition says: "never" only when it says so, else the default. */
export const approvalsOf = (value: unknown): Approvals => (value === "never" ? "never" : "ask");

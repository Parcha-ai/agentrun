// The model's commands, and the checks that run what it wrote, run only in a sandbox built for them. The self-tools
// sandbox image sets PDA_SELF_TOOLS_SANDBOX=1 (and nothing else does); everywhere else these entry points refuse.

export const SANDBOX_ENV = "PDA_SELF_TOOLS_SANDBOX";

export class SandboxRequired extends Error {
  constructor(what: string) {
    super(`${what} runs model-written code and only runs inside the self-tools sandbox (${SANDBOX_ENV}=1 is set there and nowhere else)`);
    this.name = "SandboxRequired";
  }
}

export function requireSandbox(what: string): void {
  if (process.env[SANDBOX_ENV] !== "1") throw new SandboxRequired(what);
}

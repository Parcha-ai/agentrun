import logo from "@/assets/branding/agentrun-logo.png";

/** The supplied artwork has light lettering and transparency; its backing keeps it legible in either theme. */
export function Wordmark() {
  return <span className="inline-flex bg-brand-surface align-middle"><img src={logo} alt="AgentRun" width={648} height={146} className="h-8 w-auto" /></span>;
}

import type { LearningModelAccess } from "@/lib/learning";
import { Banner } from "./ui/banner";
import { buttonVariants } from "./ui/button";

/** Learning uses its actual model route, not the presence of an arbitrary saved API key. */
export function LearningModelSetup({ access, scope = "agent" }: { access?: LearningModelAccess | null; scope?: "agent" | "default" }) {
  if (access?.location === "native") return <p className="text-small leading-relaxed text-muted-foreground">{access.reason ?? "This agent learns in its connected runtime using that runtime's existing model access. Its credentials stay there."}</p>;
  const missing = access?.ready === false;
  if (!missing) return <p className="text-small leading-relaxed text-muted-foreground">
    Workflow drafts are created on this AgentRun server{access?.model ? <> using <span className="font-mono break-all">{access.model}</span></> : " using its configured learning model"}.
    {" "}This needs server-side model access and has separate model usage. Your connected agent keeps its own model and tool credentials.
  </p>;
  return <Banner tone="warning" title={access.needs === "model" ? "Choose a model for learning" : "Set up model access for learning"} aria-label="Learning model setup">
    <div className="space-y-3">
      {access.model && <p>{scope === "default" ? "Default learning model" : "Learning model"}: <span className="font-mono break-all">{access.model}</span></p>}
      {access.reason && <p>{access.reason}</p>}
      <p>Workflow drafting needs a model provider's key for the selected model, or a supported sign-in on this server. A tool API key or the AgentRun connection key does not provide model access.</p>
      <p className="text-small text-muted-foreground">Drafting has separate model usage. Your connected agent keeps its own credentials.{scope === "default" && " This is the server default; each agent can use a different configured model."}</p>
      <a className={buttonVariants({ variant: "primary", size: "sm" })} href="#/settings/keys">Set up model access</a>
      <p className="text-small text-muted-foreground">Settings → API Keys → Model keys</p>
    </div>
  </Banner>;
}

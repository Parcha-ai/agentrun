import logo from "@/assets/branding/agentrun-logo.svg?raw";

/** Trusted, bundled vector artwork. Its lettering inherits the theme's foreground; no backing is needed. */
export function Wordmark() {
  return <span role="img" aria-label="AgentRun" className="inline-flex h-8 align-middle text-foreground [&>svg]:h-full [&>svg]:w-auto" dangerouslySetInnerHTML={{ __html: logo }} />;
}

// The share page (share.html, the console's second entry): one run's `agentrun.share/1` bundle, drawn from the bundle
// alone. It ships none of the console's sign-in, settings or navigation. The owner's server serves it at /share/<run>
// (serve's page.ts), behind the owner's session, and it reads that run's export with the session cookie.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { followTheme } from "@/lib/theme";
import "@/styles.css";
import { exportSource, runIdOf } from "./bundle";
import { SharePage } from "./SharePage";

followTheme();

const runId = runIdOf(window.location.pathname);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {runId
      ? <SharePage source={exportSource({ runId })} runId={runId} />
      : <main className="p-8 font-mono text-body text-muted-foreground" role="alert">This address names no run. A share preview opens at /share/&lt;run id&gt;.</main>}
  </StrictMode>,
);

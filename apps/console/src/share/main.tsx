// The share page (share.html, the console's second entry): one run's `agentrun.share/1` bundle, drawn from the bundle
// alone. It ships none of the console's sign-in, settings or navigation. The owner's server serves it at /share/<run>
// (serve's page.ts), behind the owner's session, and it reads that run's export with the session cookie. A share host
// (serve's share-host.ts) serves it at /r/<id>, public, and it reads the stored bundle at /r/<id>/bundle.json.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { followTheme } from "@/lib/theme";
import "@/styles.css";
import { exportSource, restoreOf, runIdOf, shareIdOf, storedSource } from "./bundle";
import { HostedSharePage, SharePage } from "./SharePage";

followTheme();

const runId = runIdOf(window.location.pathname);
const shareId = shareIdOf(window.location.pathname);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {shareId
      ? <HostedSharePage source={storedSource({ shareId })} />
      : runId
      ? <SharePage source={exportSource({ runId })} runId={runId} restore={restoreOf(window.location.search)} />
      : <main className="p-8 font-mono text-body text-muted-foreground" role="alert">This address names no run. A share preview opens at /share/&lt;run id&gt;.</main>}
  </StrictMode>,
);

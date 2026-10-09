// REHEARSAL SHIM, not part of the show. A switch back to the tab has to be asked by a page that can then attach as the
// run's writer: the pipe answers `run-here` to whoever asked, and a view-only stage cannot take the run. Until the pipe
// can address run-here to a tab-capable client (a change for browser-demo), the rehearsal makes the real 03 tab page do
// the asking: it finds the page of this run on a Chrome we own (CDP) and calls its own demo.switchTo("tab"), exactly
// what its switcher button does. Selected by SHOW_TAB_CDP; absent, a switch to the tab is sent as a plain frame.
import { WebSocket } from "ws";

export type TabControl = { switchToTab(): Promise<{ ok: boolean; message?: string }> };

export function cdpTabControl(cdpUrl: string, runId: string): TabControl {
  return {
    async switchToTab() {
      const targets = (await (await fetch(`${cdpUrl}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl?: string }[];
      const page = targets.find((t) => t.type === "page" && t.url.includes(`/run/${runId}`) && t.webSocketDebuggerUrl);
      if (!page) return { ok: false, message: `no tab page of run ${runId} is open on ${cdpUrl}` };
      const ws = new WebSocket(page.webSocketDebuggerUrl!, { perMessageDeflate: false });
      try {
        await new Promise<void>((resolve, reject) => (ws.once("open", () => resolve()), ws.once("error", reject)));
        const reply = new Promise<{ error?: { message: string }; result?: { exceptionDetails?: { text: string }; result?: { value?: string } } }>((resolve) => ws.once("message", (d) => resolve(JSON.parse(String(d)))));
        // The page's own state first: its switchTo takes the run over instead of asking for a switch when it thinks it is parked or lost.
        ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: `(() => { const before = JSON.stringify({ mode: demo.state.mode, placement: demo.state.placement && { where: demo.state.placement.where, env: demo.state.placement.env }, switching: demo.state.switching }); demo.switchTo("tab"); return before; })()`, returnByValue: true } }));
        const r = await reply;
        console.log(JSON.stringify({ event: "tab-control.switchToTab", pageBefore: r.result?.result?.value }));
        return r.error || r.result?.exceptionDetails ? { ok: false, message: r.error?.message ?? r.result?.exceptionDetails?.text ?? "the tab page refused" } : { ok: true };
      } finally {
        ws.close();
      }
    },
  };
}

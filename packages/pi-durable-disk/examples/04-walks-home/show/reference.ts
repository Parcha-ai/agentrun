// Reference timings for the storyboard: real switch times someone else measured on Daytona, shown with where they come
// from, and kept apart from the numbers this stage measured itself. Pure: data in, HTML out.
export type ReferenceTimings = {
  source: { url: string; title: string; recorded: string; how: string; readFrom: string };
  platform: string;
  pageColumn: string;
  serverColumn: string;
  rows: { from: string; to: string; pageSeconds: number; serverSeconds: number; agentAnswer: string }[];
};

/** What switch-beat.mjs measured on this box, in the shape of its evidence file. */
export type LocalSwitches = { startedAt?: string; switches: { target: string; serverMs: number; answer?: string }[] };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const seconds = (n: number) => `${n.toFixed(1)} s`;

/** A page on the docs site is linked by its file name, so it resolves wherever the site is served. */
function siteRelative(url: string): string {
  const u = new URL(url);
  return u.hostname.startsWith("docs.") ? u.pathname.split("/").pop()! : url;
}

export function renderReference(ref: ReferenceTimings, local?: LocalSwitches): string {
  const rows = ref.rows
    .map(
      (r) => `<tr><td>${esc(r.from)} → ${esc(r.to)}</td><td class="n">${seconds(r.pageSeconds)}</td><td class="n">${seconds(r.serverSeconds)}</td><td class="q">${esc(r.agentAnswer)}</td></tr>`,
    )
    .join("");
  const mine =
    local && local.switches.length > 0
      ? `<h3>This stage, on one machine</h3>
<p class="note"><span class="tag local">MEASURED locally</span> a second host on this box, not Daytona; the server's own clock, from receiving the switch to the new host's notice committed${local.startedAt ? ` (run ${esc(local.startedAt.slice(0, 10))})` : ""}.</p>
<table><thead><tr><th>Switch to</th><th>Server-timed</th></tr></thead><tbody>${local.switches.map((s) => `<tr><td>${esc(s.target)}</td><td class="n">${(s.serverMs / 1000).toFixed(2)} s</td></tr>`).join("")}</tbody></table>`
      : "";
  return `<section id="reference">
<h2>Reference: what a real switch took on ${esc(ref.platform)}</h2>
<p class="note"><span class="tag measured">MEASURED on ${esc(ref.platform)}</span> from <a href="${esc(siteRelative(ref.source.url))}">${esc(ref.source.title)}</a>, recorded ${esc(ref.source.recorded.slice(0, 10))}: ${esc(ref.source.how)}. Numbers read from that page's table.</p>
<table><thead><tr><th>Switch</th><th>${esc(ref.pageColumn)}</th><th>${esc(ref.serverColumn)}</th><th>The agent's answer after it</th></tr></thead><tbody>${rows}</tbody></table>
${mine}
</section>`;
}

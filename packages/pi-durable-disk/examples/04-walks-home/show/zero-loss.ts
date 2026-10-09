// "Zero loss, measured" for the storyboard: the chaos pass's results (lane D0) as the page shows them. The mounted VM
// is the headline; the GPU through the pipe is shown apart, with its own numbers. Only measured numbers, the code they
// ran on and how they were checked go on the page; the results' local fields (raw files, notes about the harness's
// folder) never do. Pure: data in, HTML out.
export type HopRound = { round: number; killPoint: string; detail: string; takeoverMs: number; loss: number };
export type Hop = {
  setup: string;
  rounds: number;
  loss: number;
  takeoverMs: { p50: number; min: number; max: number };
  ackedCommitsChecked: number;
  ackedFilesChecked: number;
  orphanedUploads?: number;
  perRound: HopRound[];
  measuredAt: string;
  commit: string;
};
export type ChaosResults = {
  measured: boolean;
  measuredAt: string;
  provenance: { repo: string; mountHopCode: string; pipeHopCode: string; harness: Record<string, string> };
  method: string;
  mountHop: Hop;
  pipeHop: Hop;
  pipeHopBeforeDigestCache?: { commit: string; takeoverMs: { p50: number; min: number; max: number }; loss: number };
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
/** Under two seconds in ms, else in seconds to one decimal. */
export const duration = (ms: number) => (ms < 2_000 ? `${Math.round(ms).toLocaleString("en-US")} ms` : `${(ms / 1000).toFixed(1)} s`);

/** How many rounds killed the host at each point, in the order the points first appear. */
function killPoints(hop: Hop): string {
  const counts = new Map<string, number>();
  for (const r of hop.perRound) counts.set(r.killPoint, (counts.get(r.killPoint) ?? 0) + 1);
  return [...counts].map(([point, n]) => `${n} ${esc(point)}`).join(", ");
}

function hopTable(hop: Hop, pipe: boolean): string {
  const rows: [string, string][] = [
    ["Host kills", `${hop.rounds}: ${killPoints(hop)}`],
    ["Takeover, kill to the tab working", `median ${duration(hop.takeoverMs.p50)} (${duration(hop.takeoverMs.min)} to ${duration(hop.takeoverMs.max)})`],
    ["Acknowledged writes checked", `${hop.ackedCommitsChecked} commits, ${hop.ackedFilesChecked} files`],
    ["Lost, or written late by a dead host", String(hop.loss)],
  ];
  if (pipe && hop.orphanedUploads !== undefined) rows.push(["Orphaned uploads left on the disk", String(hop.orphanedUploads)]);
  return `<table><tbody>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${v}</td></tr>`).join("")}</tbody></table>`;
}

/**
 * The block's headline says every acknowledged write was there, so it refuses a result that does not say so itself: not marked
 * measured, a hop that ran no rounds or checked no acknowledged writes, a hop or round with loss, a round count that does not match, or a method that is not an independent read-back (a SHA-256
 * read from the store and the mount), which is the only evidence a zero-loss claim may rest on. The pipe's own released digest is not.
 */
export function assertBacksZeroLoss(r: ChaosResults): void {
  if (r.measured !== true) throw new Error("the chaos result is not marked measured");
  for (const [name, hop] of [["mount hop", r.mountHop], ["pipe hop", r.pipeHop]] as const) {
    if (hop.rounds <= 0) throw new Error(`the ${name} ran no rounds`);
    if (hop.ackedCommitsChecked + hop.ackedFilesChecked <= 0) throw new Error(`the ${name} checked no acknowledged writes`);
    if (hop.loss !== 0) throw new Error(`the ${name} reports loss ${hop.loss}`);
    if (hop.perRound.length !== hop.rounds) throw new Error(`the ${name} says ${hop.rounds} rounds and lists ${hop.perRound.length}`);
    if (hop.perRound.some((round) => round.loss !== 0)) throw new Error(`a round of the ${name} lost something`);
    if (hop.orphanedUploads !== undefined && hop.orphanedUploads !== 0) throw new Error(`the ${name} left ${hop.orphanedUploads} orphaned uploads`);
  }
  if (!/independent read-back/i.test(r.method)) throw new Error("the method does not state an independent read-back");
  if (!/never the pipe's own/i.test(r.method)) throw new Error("the method does not say it is never the pipe's own released digest");
}

export function renderZeroLoss(r: ChaosResults): string {
  assertBacksZeroLoss(r);
  const m = r.mountHop;
  const p = r.pipeHop;
  const before = r.pipeHopBeforeDigestCache;
  const harness = Object.entries(r.provenance.harness)
    .map(([file, sha]) => `${esc(file)} <code>${esc(sha.slice(0, 12))}</code>`)
    .join(", ");
  return `<section id="zero-loss">
<h2>Zero loss, measured</h2>
<p class="note"><span class="tag measured">MEASURED</span> ${m.rounds + p.rounds} host kills, measured ${esc(r.measuredAt.slice(0, 10))}: every acknowledged write was there after the takeover, and nothing from a dead host landed after it.</p>
<div class="facts"><div><b>${m.loss + p.loss}</b><span>acknowledged writes lost</span></div><div><b>${m.rounds}</b><span>VM kills</span></div><div><b>${duration(m.takeoverMs.p50)}</b><span>takeover, median</span></div><div><b>${m.ackedCommitsChecked}</b><span>commits checked</span></div></div>
<h3>The mounted machine</h3>
<p class="note">${esc(m.setup)}.</p>
${hopTable(m, false)}
<h3>The GPU, through the pipe</h3>
<p class="note">${esc(p.setup)}. The takeover includes sending that workspace to the tab and checking every file.${before ? ` Before the workspace digest cache it took a median ${duration(before.takeoverMs.p50)}; the same pass now takes ${duration(p.takeoverMs.p50)}.` : ""}</p>
${hopTable(p, true)}
<h3>How it was checked</h3>
<p class="note">${esc(r.method)}</p>
<p class="note">Code: ${esc(r.provenance.repo)}, the mounted machine on ${esc(r.provenance.mountHopCode)}, the GPU on ${esc(r.provenance.pipeHopCode)}. Harness SHA-256: ${harness}.</p>
</section>`;
}

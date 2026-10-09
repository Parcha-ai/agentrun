// The go/no-go numbers from a story run: the server's log, the cloud instances' event log and the story's results.
//   node scripts/evidence.ts <server log> <cloud events log> <story results> [out.json]
// - handover: from the moment the tab's lease lapsed (or "move to the cloud") to the cloud instance's open run, and to
//   its first commit;
// - zero loss: the digest of what the tab saw acknowledged last equals the digest of work/ the pipe sealed at release;
// - no write after a takeover: no commit of an older cloud generation is above the head the next owner opened on, and
//   none was published after that owner's open.
import { readFileSync, writeFileSync } from "node:fs";

type Line = Record<string, unknown> & { at: string; event: string };
const read = (file: string): Line[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Line);
const [serverLog, cloudLog, storyFile, outFile] = process.argv.slice(2);
const server = read(serverLog!);
const cloud = read(cloudLog!);
const story = JSON.parse(readFileSync(storyFile!, "utf8")) as { steps: { name: string; ackedDigest?: string }[]; tabClosedAt?: string };
const t = (l: Line) => Date.parse(l.at);

// Handover: each move to the cloud, to the next cloud open and first commit of a new generation.
const handovers = [];
for (const move of server.filter((l) => l.event === "placement" && l.where === "moving" && l.to === "cloud")) {
  const open = cloud.find((c) => c.event === "open" && t(c) >= t(move));
  if (!open) continue;
  const commit = cloud.find((c) => c.event === "commit" && c.generation === open.generation && t(c) >= t(open));
  const released = server.find((l) => l.event === "pipe.released" && t(l) >= t(move));
  handovers.push({
    why: move.detail,
    at: move.at,
    releasedMs: released ? t(released) - t(move) : null,
    cloudOpenMs: t(open) - t(move),
    cloudFirstCommitMs: commit ? t(commit) - t(move) : null,
    generation: open.generation,
  });
}

// Zero loss: the tab's last acknowledged digest against the pipe's sealed digest at its release.
const closed = story.steps.find((s) => s.name.startsWith("A: tab closed"));
const firstRelease = server.find((l) => l.event === "pipe.released");
const zeroLoss = { tabAckedDigest: closed?.ackedDigest ?? null, diskDigestAtRelease: firstRelease?.workDigest ?? null, equal: Boolean(closed?.ackedDigest && closed.ackedDigest === firstRelease?.workDigest) };
const lastTab = [...story.steps].reverse().find((s) => s.ackedDigest && !s.name.startsWith("A: tab closed"));
const lastRelease = [...server].reverse().find((l) => l.event === "pipe.released");
const zeroLossEnd = { tabAckedDigest: lastTab?.ackedDigest ?? null, diskDigestAtRelease: lastRelease?.workDigest ?? null, equal: Boolean(lastTab?.ackedDigest && lastTab.ackedDigest === lastRelease?.workDigest) };

// Takeovers from the cloud: the pipe's open (its head) against every commit the older cloud generation published.
const takeovers = [];
for (const back of server.filter((l) => l.event === "placement" && l.where === "moving" && l.to === "tab")) {
  const open = server.find((l) => l.event === "pipe.open" && t(l) >= t(back));
  if (!open) continue;
  const head = Number(open.head);
  const olds = cloud.filter((c) => c.event === "commit" && Number(c.generation) < Number(open.generation));
  const exited = server.find((l) => l.event === "cloud.exited" && t(l) >= t(back));
  takeovers.push({
    at: back.at,
    pipeOpenMs: t(open) - t(back),
    newGeneration: open.generation,
    headAtOpen: head,
    oldCommitsAboveHead: olds.filter((c) => Number(c.seq) > head).length,
    oldCommitsAfterOpen: olds.filter((c) => t(c) > t(open)).length,
    oldLastSeq: Math.max(0, ...olds.map((c) => Number(c.seq))),
    cloudExit: exited ? { status: exited.status, unit: exited.unit, ms: exited.ms } : null,
  });
}

const result = { handovers, zeroLoss, zeroLossEnd, takeovers };
console.log(JSON.stringify(result, null, 1));
if (outFile) writeFileSync(outFile, `${JSON.stringify(result, null, 1)}\n`);

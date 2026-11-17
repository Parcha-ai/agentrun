// A Mode 2 run whose revision has skills, and whose computer mounts the run's folder from its Archil disk, lays its skills
// before the mount. A computer's FUSE mount of the folder takes Archil's write delegation, and while it holds, Archil
// refuses every write to the folder over its file API (409 OperationAborted: "another client holds a write delegation").
// The run's Workspace at the claim writes over that file API, so a lay after the mount is refused, the Workspace retries
// the 409 for its queue time, and the run fails ("mkdir .agents/skills: ... 409"). Both spec builders, pi's
// (adapterRunSpecFromLaunch) and the CLI harnesses' (cliRunSpecFromLaunch), are built here over the Archil fake, whose
// `delegate` stands in for the mount's delegation, taken by the run's computerForClaim and let go at its release:
//   - the claim lays the revision's skills, and the build writes nothing the delegation refuses;
//   - a second claim (epoch 2) of the same run, its folder already holding the skills (one edited by the run since),
//     mounts the folder again, writes no skill again and keeps the first claim's files as they are.
//   - a learning run's seed (its notes into .learning/, its learned skill into .agents/skills/) is laid before the mount
//     too, and the spec says it laid the learned skill (learningLaid): layLearningSeed never throws, so a build that
//     succeeds says nothing about whether the seed was laid.
// On the old order (the lay after computerForClaim) the first test's build fails with the disk's 409, after the
// Workspace's 60 s queue, and the learning test's seed is refused and taken back.
import assert from "node:assert/strict";
import { test } from "node:test";

const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { FakeArchilDisk } = await import("./fixtures/archil-fake.mjs");
const { KEY, LEARNED_KEY, mode2Run, putsOf, SKILL, SKILL_KEY } = await import("./fixtures/mode2-mounted-run.mjs");

for (const [name, harness, build] of [["pi's spec", undefined, adapterRunSpecFromLaunch], ["the CLI spec (opencode)", "opencode", cliRunSpecFromLaunch]]) {
  test(`${name} in Mode 2: a revision's skills are laid on the disk before the computer's mount takes the write delegation`, async (t) => {
    const disk = new FakeArchilDisk();
    const run = await mode2Run(t, { harness, disk });
    await run.claimNext(build);
    assert.deepEqual(disk.refusedByDelegation, [], "no write to the run's folder was refused by the mount's delegation");
    assert.equal(Buffer.from(disk.files.get(SKILL_KEY) ?? []).toString("utf8"), SKILL, "the skill is on the disk");
    assert.equal(run.mounts.length, 1, "the computer mounted the run's folder once");
    const skillPut = disk.calls.findIndex((call) => call.op === "putObject" && call.key === SKILL_KEY);
    assert.ok(skillPut >= 0 && skillPut < run.mounts[0].at, `the skill was put before the mount (put at call ${skillPut}, the mount after call ${run.mounts[0].at})`);
  });

  test(`${name} in Mode 2: a second claim of the run (epoch 2) lays no skill again under the new mount, and keeps the first claim's`, async (t) => {
    const disk = new FakeArchilDisk();
    const run = await mode2Run(t, { harness, disk });
    // The first claim's lease lapses at once, and the first claim lets its computer go (its mount's delegation with it),
    // as a runner that lets a claim go does.
    const first = await run.claimNext(build, { leaseMs: 1 });
    assert.equal(first.claim.epoch, 1);
    const firstPuts = putsOf(disk, `${KEY}/.agents/skills`).length;
    assert.ok(firstPuts > 0, "the first claim laid the skill");
    // The run's own edit of its skill, which a later claim must never write over.
    disk.files.set(SKILL_KEY, Buffer.from(`${SKILL}Edited by the run.\n`));
    await first.spec.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await run.claimNext(build);
    assert.equal(second.claim.epoch, 2, "the run is claimed again, at epoch 2");
    assert.equal(run.mounts.length, 2, "each claim's computer mounted the run's folder");
    assert.deepEqual(disk.refusedByDelegation, [], "no write to the run's folder was refused by a mount's delegation");
    assert.equal(putsOf(disk, `${KEY}/.agents/skills`).length, firstPuts, "the second claim put nothing under .agents/skills");
    assert.equal(Buffer.from(disk.files.get(SKILL_KEY)).toString("utf8"), `${SKILL}Edited by the run.\n`, "the first claim's skill, as the run left it");
  });

  test(`${name} in Mode 2: a learning run's seed, its notes and its learned skill, is laid on the disk before the mount`, async (t) => {
    const disk = new FakeArchilDisk();
    const run = await mode2Run(t, { harness, disk, learns: true });
    const { spec } = await run.claimNext(build);
    assert.deepEqual(disk.refusedByDelegation, [], "no write to the run's folder was refused by the mount's delegation");
    assert.deepEqual(spec.learningLaid?.skills, ["summarize"], "the spec says the claim laid the learned skill");
    // The lay writes the skill's front matter back in its own form (its values quoted): its name and body are the seed's.
    const learned = Buffer.from(disk.files.get(LEARNED_KEY) ?? []).toString("utf8");
    assert.match(learned, /^---\nname: "?summarize"?\n[\s\S]*\n---\nSummarize every source in one line\.\n$/, `the learned skill is on the disk: ${JSON.stringify(learned)}`);
    const notePut = disk.calls.findIndex((call) => call.op === "putObject" && call.key.startsWith(`${KEY}/.learning/`) && call.key.endsWith("retry-slowly.md"));
    const learnedPut = disk.calls.findIndex((call) => call.op === "putObject" && call.key === LEARNED_KEY);
    assert.equal(run.mounts.length, 1, "the computer mounted the run's folder once");
    assert.ok(notePut >= 0 && notePut < run.mounts[0].at, `the seed's note was put in .learning/ before the mount (put at call ${notePut}, the mount after call ${run.mounts[0].at})`);
    assert.ok(learnedPut >= 0 && learnedPut < run.mounts[0].at, `the learned skill was put before the mount (put at call ${learnedPut}, the mount after call ${run.mounts[0].at})`);
  });
}

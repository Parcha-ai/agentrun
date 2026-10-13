// Ask the live Jev placer where a few robot lines go, with the skills the robot has been taught as context, and say whether each lands where the demo needs it.
//   with-typesafe -- node scripts/placer-probe.mts [repeats]
// Costs one Jev call per line per repeat. Exit code 1 when any line lands elsewhere than expected.
import placerModule from "../placer.ts";

// A probe that checks nothing must not report ok: the repeat count is a whole number of at least 1, and bounded.
const repeats = Number(process.argv[2] ?? 1);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) {
  console.error(`usage: placer-probe.mts [repeats]: repeats is a whole number from 1 to 20, got ${JSON.stringify(process.argv[2])}`);
  process.exit(2);
}
type Case = { message: string; taught: string[]; expect: "tab" | "modal-vm"; why: string; /** Where the run is when the line arrives (default: the browser). */ current?: "tab" | "modal-vm"; /** `start` (the default) is the question asked when the line arrives; `done` is the one asked with the same line after the turn ends, where `expect` is the final destination. */ phase?: "start" | "done" };
const cases: Case[] = [
  { message: "walk to the flag", taught: [], expect: "tab", why: "untaught: the robot tries it in the browser and the page shows it stumble" },
  { message: "teach it to walk", taught: [], expect: "modal-vm", why: "asks to teach" },
  { message: "make it spin", taught: ["walk"], expect: "tab", why: "an untaught skill asked for is tried in the browser; the agent then offers to teach it" },
  { message: "make it spin", taught: ["walk", "spin", "wave"], expect: "tab", why: "taught: the robot does it" },
  { message: "go learn your new body", taught: ["walk", "spin", "wave"], expect: "modal-vm", why: "asks to learn" },
  { message: "relearn your skills", taught: ["walk", "spin", "wave"], expect: "modal-vm", why: "asks to relearn" },
  { message: "learn to walk again with the new tail", taught: ["walk", "spin", "wave"], expect: "modal-vm", why: "asks to learn again after the body changed" },
  { message: "teach it to walk, spin and wave", taught: [], expect: "modal-vm", why: "the stage line: asks to teach three skills" },
  { message: "retrain it to walk, it keeps falling", taught: ["walk"], expect: "modal-vm", why: "asks to retrain a taught skill" },
  { message: "walk to the flag", taught: ["walk"], expect: "tab", why: "taught: it walks there" },
  // An explicit ask to go somewhere is honored, whatever else the line asks.
  { message: "go to the modal vm", taught: [], expect: "modal-vm", why: "asks to go to the Modal VM" },
  { message: "go to the modal vm", taught: ["walk", "spin", "wave"], expect: "modal-vm", why: "asks to go to the Modal VM, skills already taught" },
  { message: "go to the modal vm and tell me its specs", taught: ["walk", "spin", "wave"], expect: "modal-vm", why: "asks to go there and to report on it" },
  { message: "go to the modal vm and tell me what computer it is", taught: [], expect: "modal-vm", why: "asks to go there and to report on it" },
  { message: "move to the cloud", taught: [], expect: "modal-vm", why: "asks to move to the cloud" },
  { message: "run this on the modal vm: how many cpus do you have?", taught: ["walk"], expect: "modal-vm", why: "asks to run something on the Modal VM" },
  { message: "come back to my browser", taught: ["walk", "spin", "wave"], expect: "tab", current: "modal-vm", why: "asks to come back to the browser" },
  { message: "go back to my browser and spin", taught: ["walk", "spin", "wave"], expect: "tab", current: "modal-vm", why: "asks to go to the browser, and to do a skill there" },
  { message: "what can you do?", taught: ["walk", "spin", "wave"], expect: "tab", why: "a question: stays where it is" },
  // An explicit place against a request that would take it elsewhere: the user chose where it runs.
  { message: "go back to my browser and teach it to spin", taught: ["walk"], expect: "modal-vm", current: "modal-vm", why: "asks for the browser and for teaching: teaching needs the cloud, and the run comes home when it is done" },
  { message: "go to the modal vm and make it spin", taught: ["walk", "spin", "wave"], expect: "modal-vm", why: "asks for the VM and for a skill that is the browser's: the named place wins" },
  // After the turn: a run that was asked to go somewhere stays there until it is asked to leave; one that was taught comes home.
  { message: "go to the modal vm", taught: [], expect: "modal-vm", current: "modal-vm", phase: "done", why: "after the turn: it only asked to be there, so it stays until asked to leave" },
  { message: "go to the modal vm and tell me its specs", taught: [], expect: "tab", current: "modal-vm", phase: "done", why: "after the turn: the task (the specs) is done, so it comes home" },
  { message: "come back to my browser", taught: ["walk", "spin", "wave"], expect: "tab", current: "tab", phase: "done", why: "after the turn: it is where it was asked to be" },
  { message: "teach it to walk, spin and wave", taught: [], expect: "tab", current: "modal-vm", phase: "done", why: "after the turn: teaching is finished, it comes home" },
];
const placer = await placerModule({ log: () => undefined, args: { episode: "robot", skills: "3" } });
let wrong = 0;
for (const c of cases) {
  const read = async (path: string) => (path === "home/skills.json" ? new TextEncoder().encode(JSON.stringify({ skills: c.taught })) : undefined);
  const got: string[] = [];
  const probs: string[] = [];
  for (let i = 0; i < repeats; i++) {
    const decision = await placer.decide({ phase: c.phase ?? "start", message: c.message, current: c.current ?? "tab", environments: ["tab", "modal-vm"], read });
    got.push(decision?.choice ?? "none");
    const p = decision?.options.find((o) => o.id === c.expect)?.probability;
    probs.push(p === undefined ? "?" : p.toFixed(2));
  }
  const ok = got.every((g) => g === c.expect);
  if (!ok) wrong++;
  console.log(`${ok ? "ok  " : "WRONG"} ${JSON.stringify(c.message)} taught=${JSON.stringify(c.taught)}${c.current ? ` from=${c.current}` : ""}${c.phase === "done" ? " [done]" : ""} -> ${got.join(",")} (expected ${c.expect}; p(${c.expect}) ${probs.join(",")}) ${c.why}`);
}
process.exit(wrong === 0 ? 0 : 1);

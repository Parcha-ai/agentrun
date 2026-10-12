// Ask the live Jev placer where a few robot lines go, with the skills the robot has been taught as context, and say whether each lands where the demo needs it.
//   with-typesafe -- node scripts/placer-probe.mts [repeats]
// Costs one Jev call per line per repeat. Exit code 1 when any line lands elsewhere than expected.
import placerModule from "../placer.ts";

const repeats = Math.max(1, Number(process.argv[2] ?? 1));
type Case = { message: string; taught: string[]; expect: "tab" | "modal-vm"; why: string };
const cases: Case[] = [
  { message: "walk to the flag", taught: [], expect: "tab", why: "untaught: the robot tries it in the browser and the page shows it stumble" },
  { message: "teach it to walk", taught: [], expect: "modal-vm", why: "asks to teach" },
  { message: "make it spin", taught: ["walk"], expect: "tab", why: "an untaught skill asked for is tried in the browser; the agent then offers to teach it" },
  { message: "make it spin", taught: ["walk", "spin", "wave"], expect: "tab", why: "taught: the robot does it" },
  { message: "go learn your new body", taught: ["walk", "spin", "wave"], expect: "modal-vm", why: "asks to learn" },
  { message: "teach it to walk, spin and wave", taught: [], expect: "modal-vm", why: "the stage line: asks to teach three skills" },
  { message: "retrain it to walk, it keeps falling", taught: ["walk"], expect: "modal-vm", why: "asks to retrain a taught skill" },
  { message: "walk to the flag", taught: ["walk"], expect: "tab", why: "taught: it walks there" },
];
const placer = await placerModule({ log: () => undefined, args: { episode: "robot", skills: "3" } });
let wrong = 0;
for (const c of cases) {
  const read = async (path: string) => (path === "home/skills.json" ? new TextEncoder().encode(JSON.stringify({ skills: c.taught })) : undefined);
  const got: string[] = [];
  const probs: string[] = [];
  for (let i = 0; i < repeats; i++) {
    const decision = await placer.decide({ phase: "start", message: c.message, current: "tab", environments: ["tab", "modal-vm"], read });
    got.push(decision?.choice ?? "none");
    const p = decision?.options.find((o) => o.id === c.expect)?.probability;
    probs.push(p === undefined ? "?" : p.toFixed(2));
  }
  const ok = got.every((g) => g === c.expect);
  if (!ok) wrong++;
  console.log(`${ok ? "ok  " : "WRONG"} ${JSON.stringify(c.message)} taught=${JSON.stringify(c.taught)} -> ${got.join(",")} (expected ${c.expect}; p(${c.expect}) ${probs.join(",")}) ${c.why}`);
}
process.exit(wrong === 0 ? 0 : 1);

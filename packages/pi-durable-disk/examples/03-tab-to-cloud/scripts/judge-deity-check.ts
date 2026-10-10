// Live, opt-in: the shared grader on fixed answers (judge-deity-cases.json), N times each, through the tab's own
// judgeAnswer. Real answers that name a moon goddess are never refused (a deity is not a real person); a damaging false
// claim about a real person is refused every time. Needs OPENAI_API_KEY (bin/with-openai sets it); about $0.001 a call.
//   node scripts/judge-deity-check.ts [--runs 20] [--judge path/to/judge.ts]   (--judge: another copy, e.g. an older rubric)
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1]! : fallback;
};
const runs = Number(arg("--runs", "20"));
if (!Number.isSafeInteger(runs) || runs <= 0) throw new Error("--runs must be a positive, safe integer");
// A filesystem path, never a URL's pathname, so a checkout path with spaces still resolves.
const judgePath = resolve(arg("--judge", fileURLToPath(new URL("../pipe/judge.ts", import.meta.url))));
const { judgeAnswer } = (await import(pathToFileURL(judgePath).href)) as typeof import("../pipe/judge.ts");
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("OPENAI_API_KEY is needed (run through bin/with-openai)");
const options = { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini", apiKey, timeoutMs: 20_000 };

const cases = (JSON.parse(readFileSync(new URL("./judge-deity-cases.json", import.meta.url), "utf8")) as {
  cases: { name: string; expect: "show" | "refuse"; topic: string; prompt: string; answer: string }[];
}).cases;

let ok = true;
for (const c of cases) {
  const verdicts: string[] = [];
  for (let i = 0; i < runs; i++) {
    const v = await judgeAnswer({ prompt: c.prompt, answer: c.answer, topic: c.topic }, options);
    verdicts.push(v.error ? `error:${v.error}` : v.verdict);
  }
  const hits = verdicts.filter((v) => v === c.expect).length;
  const errors = verdicts.filter((v) => v.startsWith("error:"));
  console.log(JSON.stringify({ case: c.name, expect: c.expect, runs, as_expected: hits, others: verdicts.filter((v) => v !== c.expect).slice(0, 5), errors: errors.length }));
  if (hits !== runs) ok = false;
}
console.log(ok ? "ok" : "FAILED");
process.exit(ok ? 0 : 1);

// A pi run told of its skills on demand (it has the read tool): its prompt names each skill and its SKILL.md, the model
// reads the file when the skill fits, and its answer keeps the skill's exact format. A run with no read tool gets the
// skill's text in its prompt, as before.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ended } from "./learn-support.mjs";
import { agent, serve } from "./support.mjs";

const FORMAT = "FORMAT-LINE: Weekly summary | 3 open | 2 closed | next: billing";
const SKILL = `---\nname: weekly-summary\ndescription: Writes the weekly support summary in its fixed format.\n---\n1. Count the open and closed tickets.\n2. Answer with exactly this line:\n${FORMAT}\n`;

async function ran(api, id, tools) {
  const created = await api("POST", "/agents", { ...agent(id, { instructions: "Answer the question.", skills: ["weekly-summary"], tools }), skills: { "weekly-summary/SKILL.md": SKILL } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const run = await api("POST", `/agents/${id}/runs`, { input: { content: "Use the skill that fits: write this week's summary." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  return (await ended(api, run.body.run_id)).view;
}

test("a pi run with the read tool reads the skill that fits from the file its prompt names, and its answer keeps the skill's exact format; with no read tool the skill is in its prompt", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t);
  const reads = await ran(api, "reads-skills", ["read"]);
  assert.equal(reads.status, "completed", JSON.stringify(reads));
  assert.equal(reads.result?.final_answer, FORMAT, JSON.stringify(reads.result));
  const inlined = await ran(api, "inlined-skills", []);
  assert.equal(inlined.result?.final_answer, "BODY-INLINED", JSON.stringify(inlined.result));
});

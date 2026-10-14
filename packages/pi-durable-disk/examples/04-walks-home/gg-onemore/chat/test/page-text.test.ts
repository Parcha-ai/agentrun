import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { GG_INSTRUCTIONS, GG_SWITCH_TEXT } from "../gg-text.ts";
import { STEER_INSTRUCTIONS } from "../steer-text.ts";

const skill = (name: string) => readFileSync(new URL(`../../skills/${name}/SKILL.md`, import.meta.url), "utf8");

test("both pages put the proof in the message: both replies quoted verbatim under Edit off: and Edit on:, not summed up in the thinking", () => {
  for (const text of [GG_INSTRUCTIONS, STEER_INSTRUCTIONS]) {
    assert.match(text, /quote both replies verbatim/);
    assert.match(text, /"Edit off:" and "Edit on:"/);
    assert.match(text, /not in your thinking/);
  }
  assert.match(skill("golden-gate"), /"Edit off:" and "Edit on:"/, "the skill's proof step says the same");
});

test("the golden-gate skill picks its strength by Jev's ranking against the shipped recipe, with the floors", () => {
  const s = skill("golden-gate");
  assert.match(s, /gglab\.recipe\("golden-gate"\)/, "the shipped recipe is sampled on the same prompts");
  assert.match(s, /gglab\.rank\(/);
  assert.match(s, /gglab\.grade\(/);
  assert.match(s, /tries_rate` 0\.5 or more/);
  assert.match(s, /loop_rate` under 0\.35/);
  assert.doesNotMatch(s, /Keep the strengths that still try most of the time, then take the most obsessed of those/, "the rule that served a tame clamp is gone");
});

test("the edited model opens on a plain greeting: in Jev's judging it argued about who it is in half the replies, not three in four", () => {
  assert.equal(GG_SWITCH_TEXT, "Hi! How's it going?");
});

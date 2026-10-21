// What a teaching thread, and the session that forked it, can read about GPUs. The take's threads thought "there is a note about no GPU, but the instructions mention an H100": the VM's environment notice
// said "no GPU" bare, and every thread forks from the conversation that holds it. One truth, said together: the VM itself has no GPU, and each thread's commands run on the H100 box lent to it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { noticeText } from "../../../03-tab-to-cloud/environment.ts";
import { ROBOT_SOP, TEACH_SOP, TRAIN_SOP } from "../../cluster/sop.ts";
import { CRITERIA, CRITERIA_ROBOT } from "../placer.ts";
import { modalVmNote } from "../transport-boxes.ts";

/** A claim that a place has no GPU: "no GPU", "no GPUs", "without a GPU". A box that was not given ("no GPU box came up") is a failure report, not a claim about the place. */
const CLAIM = /\b(?:no GPUs?(?! box)|without a GPU)\b/gi;

/** The sentence a match is in. */
const sentenceAt = (text: string, at: number): string => {
  const start = Math.max(text.lastIndexOf(". ", at), text.lastIndexOf("\n", at)) + 1;
  const end = [text.indexOf(". ", at), text.indexOf("\n", at)].filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? text.length;
  return text.slice(start, end + 1);
};

/** Every claim of "no GPU" in a text the VM's session or its threads read must be about the VM itself, and the text must say beside it that the H100s are lent to the threads. */
function assertNoGpuClaimAboutTheThread(name: string, text: string): void {
  for (const m of text.matchAll(CLAIM)) {
    const sentence = sentenceAt(text, m.index!);
    assert.match(sentence, /\bitself\b|\bof its own\b/i, `${name}: "${sentence.trim()}" says no GPU without saying it is the VM itself`);
    assert.match(text, /\bH100\b/, `${name}: says the VM has no GPU and never mentions the H100 the thread is lent`);
    assert.match(text, /\blent\b|\blends\b|\bborrow/i, `${name}: says the VM has no GPU and never says the H100 is lent`);
  }
}

const vmNotice = noticeText(
  { label: "a Modal VM", hostClass: "modal-vm", cpus: 8, memoryGb: 32, gpu: null, tools: ["bash", "node"], network: true, os: "Linux 6.1", note: modalVmNote(true) },
  { id: "s1", from: "your user's browser tab", planned: true, by: "placement" },
);

test("the Modal VM's environment notice, which every fork inherits, says the VM itself has no GPU and that each thread's H100 is lent", () => {
  assertNoGpuClaimAboutTheThread("the VM's notice", vmNotice);
  assert.match(vmNotice, /H100 box lent to it/);
});

test("the notice of a host with no lent GPUs says no GPU only about the machine itself", () => {
  const tab = noticeText({ label: "your user's browser tab", cpus: 4, memoryGb: 8, gpu: null, tools: [], network: true }, { id: "s2", from: "a Modal VM", planned: true });
  assert.doesNotMatch(tab.replace(/no GPU on this machine itself/g, ""), /\bno GPU\b/);
});

test("no place text, SOP or instruction a thread or the session reads says the thread has no GPU", () => {
  const sources: Record<string, string> = {
    "the placer's modal-vm place": CRITERIA["modal-vm"]!,
    "the robot episode's modal-vm place": CRITERIA_ROBOT["modal-vm"]!,
    "robot.md": ROBOT_SOP,
    "teach.md": TEACH_SOP,
    "train-skill.md": TRAIN_SOP,
    "the VM notice": vmNotice,
  };
  for (const file of ["../../cluster/teach-skills.ts", "../robot-extra.ts", "../../../03-tab-to-cloud/agent.ts"]) sources[file] = readFileSync(new URL(file, import.meta.url), "utf8");
  for (const [name, text] of Object.entries(sources)) {
    // The default places are single lines: the lent H100 is in the next entry (modal-gpu), so only the "itself" rule applies to them.
    if (name.endsWith("modal-vm place") && !name.startsWith("the robot")) {
      for (const m of text.matchAll(CLAIM)) assert.match(sentenceAt(text, m.index!), /\bitself\b/i, name);
      continue;
    }
    assertNoGpuClaimAboutTheThread(name, text);
  }
});

test("the thread's SOP tells it the notice about no GPU is about the VM, and its H100 is its own", () => {
  assert.match(TRAIN_SOP, /Where your commands run/);
  assert.match(TRAIN_SOP, /not on the VM that forked you/);
  assert.match(TRAIN_SOP, /VM, which has no GPU of its own/);
  assert.match(TRAIN_SOP, /nvidia-smi/);
});

test("the session's SOP tells it to explain why it is in the cloud, as its first line on arriving and before a move it starts, in its own words and never as a fixed line", () => {
  const section = TEACH_SOP.slice(TEACH_SOP.indexOf("## Say why you are in the cloud"), TEACH_SOP.indexOf("## Plan the skills"));
  assert.ok(section.length > 100, "teach.md has the section");
  assert.match(section, /first line on arriving/);
  assert.match(section, /before you call `switch_environment`/);
  assert.match(section, /own words/);
  assert.match(section, /never recite a stock line/);
  for (const topic of [/takes GPUs/, /tab has none/, /Modal VM/, /eight H100s/]) assert.match(section, topic);
  // An instruction about what to explain, not a string to say: no quoted sentence in the section.
  assert.doesNotMatch(section, /["“][^"”]{25,}["”]/);
});

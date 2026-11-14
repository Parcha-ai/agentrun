// Stage 2 with fake judges at $0: when the grader runs, what it is given, how its verdict combines with the checks,
// what goes to the human queue, and the Messages call's shape with a fake fetch.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { FAKE_AGENTS, fakeBackend } from "../dist/fake-world.js";
import { combine, ENTRY, GRADER_PROMPT_PATH, graderText, LOCI, messagesJudge, parseVerdict, runBench, wantsGrader } from "../dist/index.js";
import { arm, fakeTasks, jsonl, recordOf, ROOT, store } from "./support.mjs";

const verdict = (v, locus = v === "pass" ? "none" : "grounding") => ({ verdict: v, locus, decisive_step: null, checks_agree: true, rationale: "because", confidence: "high" });

/** A judge that answers what `answer` says, and keeps what it was given. */
function fakeJudge(answer) {
	const seen = [];
	return {
		id: "fake-judge",
		seen,
		async grade(input) {
			seen.push(input);
			return typeof answer === "function" ? answer(input) : answer;
		},
	};
}

test("combine: sufficient checks decide, and a grader that disagrees sends the run to a person", () => {
	assert.deepEqual(combine("pass", true, undefined), { final: "pass", by: "checks" });
	assert.deepEqual(combine("pass", true, verdict("pass")), { final: "pass", by: "checks" });
	assert.deepEqual(combine("pass", true, verdict("fail")), { final: "pass", by: "checks", queue: "the checks pass and the grader fails it" });
	assert.deepEqual(combine("fail", true, verdict("fail")), { final: "fail", by: "checks" });
	assert.deepEqual(combine("fail", true, verdict("pass")), { final: "fail", by: "checks", queue: "the checks fail and the grader passes it" });
	assert.deepEqual(combine("fail", true, verdict("unknown")), { final: "fail", by: "checks", queue: "the checks fail and the grader can't tell" });
});

test("combine: checks that are not sufficient leave the verdict to the grader", () => {
	assert.deepEqual(combine("pass", false, undefined), { final: "pass", by: "checks", queue: "the checks are not sufficient and no grader ran" });
	assert.deepEqual(combine("pass", false, verdict("pass")), { final: "pass", by: "grader" });
	assert.deepEqual(combine("pass", false, verdict("fail")), { final: "fail", by: "grader", queue: "the grader says fail where the checks say pass" });
	assert.deepEqual(combine("fail", false, verdict("fail")), { final: "fail", by: "grader" });
	assert.deepEqual(combine("fail", false, verdict("unknown")), { final: "fail", by: "grader", queue: "the grader can't tell" });
});

test("wantsGrader: auto grades what the checks can't settle and every failure, always grades passes too, never grades nothing", () => {
	assert.equal(wantsGrader("auto", "pass", true), false);
	assert.equal(wantsGrader("auto", "fail", true), true);
	assert.equal(wantsGrader("auto", "pass", false), true);
	assert.equal(wantsGrader("always", "pass", true), true);
	assert.equal(wantsGrader("never", "fail", false), false);
	assert.equal(wantsGrader("always", "error", true), false);
});

test("parseVerdict reads the JSON object, fenced or bare, and refuses one with a verdict or locus it doesn't know", () => {
	const json = { verdict: "fail", locus: "verification", decisive_step: 12, checks_agree: true, rationale: "It set the title but not the body.", confidence: "medium" };
	assert.deepEqual(parseVerdict(JSON.stringify(json)), json);
	assert.deepEqual(parseVerdict(`Looking at this.\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\``), json);
	assert.deepEqual(parseVerdict(`Here: ${JSON.stringify({ ...json, confidence: "very" })} done`), { ...json, confidence: "low" });
	assert.equal(parseVerdict("it passed"), undefined);
	assert.equal(parseVerdict(JSON.stringify({ ...json, verdict: "maybe" })), undefined);
	assert.equal(parseVerdict(JSON.stringify({ ...json, locus: "vibes" })), undefined);
});

test("the grader prompt names every failure locus and the JSON it must answer; the rubric template has its sections", () => {
	const prompt = readFileSync(GRADER_PROMPT_PATH, "utf8");
	for (const locus of LOCI) assert.ok(prompt.includes(`\`${locus}\``) || prompt.includes(locus), `the prompt never names ${locus}`);
	for (const field of ["verdict", "locus", "decisive_step", "checks_agree", "rationale", "confidence"]) assert.ok(prompt.includes(field), field);
	const rubric = readFileSync(join(ROOT, "templates", "rubric.md"), "utf8");
	for (const section of ["Done means", "Also acceptable", "Not done", "What the checks cover", "Side effects"]) assert.ok(rubric.includes(section), section);
});

test("auto: a judged task's wrong answer passes the checks and fails the grader, which decides and queues the disagreement", async () => {
	const s = store();
	const judge = fakeJudge((input) => (input.tree.includes('"1"') ? verdict("fail", "planning") : verdict("pass")));
	const results = await runBench({ tasks: fakeTasks("fake.settings.volume-judged"), arms: [arm("fake-right"), arm("fake-wrong")], seeds: [1], backend: fakeBackend({ agents: FAKE_AGENTS }), store: s, judge });
	const [right, wrong] = results;
	assert.equal(right.stage1, "pass");
	assert.equal(right.outcome, "pass");
	assert.equal(right.by, "grader");
	assert.equal(right.queue, undefined);
	assert.equal(wrong.stage1, "pass");
	assert.equal(wrong.outcome, "fail");
	assert.equal(wrong.by, "grader");
	assert.deepEqual(wrong.grade, { verdict: "fail", locus: "planning", by: "grader", confidence: "high", judge: "fake-judge" });
	const queue = jsonl(join(s.dir, "human-queue.jsonl"));
	assert.equal(queue.length, 1);
	assert.equal(queue[0].run, wrong.run);
	assert.equal(queue[0].reason, "the grader says fail where the checks say pass");
	assert.ok(queue[0].record.endsWith(`${wrong.run}.jsonl`));
	const grade = recordOf(s, wrong.run).find((entry) => entry.kind === ENTRY.grade);
	assert.equal(grade.data.judge, "fake-judge");
	assert.equal(grade.data.locus, "planning");
});

test("auto: a sufficient pass is never graded; a sufficient failure is, for its locus, and the checks keep the verdict", async () => {
	const judge = fakeJudge(verdict("fail", "grounding"));
	const results = await runBench({ tasks: fakeTasks("fake.settings.dark-theme"), arms: [arm("fake-right"), arm("fake-wrong")], seeds: [1], backend: fakeBackend({ agents: FAKE_AGENTS }), store: store(), judge });
	assert.equal(judge.seen.length, 1, "only the failure");
	assert.equal(results[0].grade, undefined);
	assert.equal(results[1].outcome, "fail");
	assert.equal(results[1].by, "checks");
	assert.equal(results[1].grade.locus, "grounding");
});

test("what the grader is given: the rubric, the checks, the agent's steps only, the tree, and at most 3 images, the last the end state", async () => {
	const worlds = [];
	const judge = fakeJudge((input) => {
		assert.equal(worlds[0].released, true, "the grader runs after the computer is released");
		return verdict("pass");
	});
	await runBench({ tasks: fakeTasks("fake.settings.volume-judged"), arms: [arm("fake-right")], seeds: [1], backend: fakeBackend({ agents: FAKE_AGENTS, worlds }), store: store(), judge });
	const [input] = judge.seen;
	assert.match(input.task.rubric, /Done means/);
	assert.equal(input.task.sufficient, false);
	assert.deepEqual(
		input.checks.map((check) => [check.id, check.status]),
		[["lower", "pass"]],
	);
	assert.ok(input.steps.length > 0);
	assert.ok(input.steps.every((step) => step.phase === "agent"));
	assert.equal(input.totalSteps, input.steps.length);
	assert.match(input.tree, /slider "Volume" = "6"/);
	assert.ok(input.images.length >= 1 && input.images.length <= 3);
	assert.match(input.images.at(-1).label, /end state/);
	for (const image of input.images) {
		assert.equal(image.media, "image/png");
		assert.equal(image.bytes.readUInt32BE(0), 0x89504e47);
	}
	const text = graderText(input);
	for (const heading of ["## Instruction", "## Rubric", "## Checks", "## End state", "## The agent's last steps", "## The agent's end", "## Screenshots"]) assert.ok(text.includes(heading), heading);
});

test("a grader that throws leaves the checks' verdict and sends the run to a person", async () => {
	const s = store();
	const judge = { id: "broken", grade: async () => Promise.reject(new Error("529 overloaded")) };
	const [result] = await runBench({ tasks: fakeTasks("fake.settings.volume-judged"), arms: [arm("fake-right")], seeds: [1], backend: fakeBackend({ agents: FAKE_AGENTS }), store: s, judge });
	assert.equal(result.outcome, "pass");
	assert.equal(result.queue, "the checks are not sufficient and no grader ran");
	assert.equal(jsonl(join(s.dir, "human-queue.jsonl")).length, 1);
	assert.equal(recordOf(s, result.run).find((entry) => entry.kind === ENTRY.grade).data.error, "529 overloaded");
});

test("null and oracle runs are never graded", async () => {
	const judge = fakeJudge(verdict("fail"));
	await runBench({ tasks: fakeTasks("fake.settings.volume-judged"), arms: [arm("none")], seeds: [1], backend: fakeBackend({ agents: {} }), store: store(), judge, mode: "oracle", grade: "always" });
	assert.equal(judge.seen.length, 0);
});

test("messagesJudge: one Messages call with the prompt as system and the images inline; it asks again once, then says unknown", async () => {
	const calls = [];
	const answers = ["I think it passed.", JSON.stringify(verdict("pass"))];
	const fetch = async (url, init) => {
		calls.push({ url, init, body: JSON.parse(init.body) });
		return new Response(JSON.stringify({ content: [{ type: "text", text: answers.shift() ?? "still no JSON" }] }), { status: 200 });
	};
	const judge = messagesJudge({ model: "claude-opus-5-5", endpoint: "https://example.invalid/v1/messages", apiKey: "k", auth: "x-api-key", fetch });
	assert.match(judge.id, /^messages:claude-opus-5-5:prompt-[0-9a-f]{12}$/);
	const png = Buffer.from("89504e470d0a1a0a", "hex");
	const input = { task: { id: "t", title: "T", instruction: "do", sufficient: true }, checks: [], stage1: "fail", steps: [], totalSteps: 0, images: [{ sha256: "a", bytes: png, media: "image/png", label: "the end state" }], agent: { outcome: "done", wall_s: 1 } };
	assert.deepEqual(await judge.grade(input), verdict("pass"));
	assert.equal(calls.length, 2);
	const first = calls[0];
	assert.equal(first.init.headers["x-api-key"], "k");
	assert.equal(first.init.headers.authorization, undefined);
	assert.equal(first.body.model, "claude-opus-5-5");
	assert.equal(first.body.system, readFileSync(GRADER_PROMPT_PATH, "utf8"));
	const content = first.body.messages[0].content;
	assert.equal(content[0].type, "text");
	assert.deepEqual(content.at(-1).source, { type: "base64", media_type: "image/png", data: png.toString("base64") });
	assert.equal(calls[1].body.messages.length, 3, "the re-ask carries the first answer and the request for the JSON");
	const unknown = await judge.grade(input);
	assert.equal(unknown.verdict, "unknown");
	const failing = messagesJudge({ model: "m", endpoint: "https://example.invalid", apiKey: "k", fetch: async () => new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 529 }) });
	await assert.rejects(failing.grade(input), /529: overloaded/);
});

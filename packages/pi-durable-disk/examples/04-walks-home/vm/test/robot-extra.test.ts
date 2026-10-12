// The robot's extra of the cloud app, with a fake link: a thread's acquire asks the server for its box, puts pi-run and the session's robot.json
// on it, and a release gives the box back; without a link the extra refuses to load (the threads' boxes are the server's).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

type Exec = { argv: string[]; stdin: string };

function fakeLink() {
  const execs: Exec[] = [];
  const acquired: string[] = [];
  const released: string[] = [];
  const link = {
    gpu: {
      acquire: async (thread: string) => (acquired.push(thread), `box-${thread}`),
      release: async (thread: string) => void released.push(thread),
      linkBox: (id: string) => ({
        sandboxId: id,
        poll: async () => null,
        exec: async (argv: string[]) => {
          const rec: Exec = { argv, stdin: "" };
          execs.push(rec);
          const empty = (async function* () {})();
          return {
            stdin: { writeBytes: async (b: Uint8Array) => void (rec.stdin += new TextDecoder().decode(b)), close: async () => undefined },
            stdout: empty,
            stderr: (async function* () {})(),
            wait: async () => 0,
          };
        },
      }),
    },
  };
  return { link, execs, acquired, released };
}

test("acquire asks the server for the thread's box, installs pi-run, copies the session's robot.json, and release gives it back", async () => {
  const work = mkdtempSync(join(tmpdir(), "robot-extra-"));
  try {
    mkdirSync(join(work, "creature"), { recursive: true });
    writeFileSync(join(work, "creature", "robot.json"), '{"design":{"legs":4}}');
    const { default: robotExtra, robotBoxes } = await import("../robot-extra.ts");
    const f = fakeLink();
    const logs: string[] = [];
    const extra = robotExtra({ link: f.link as never, work, log: (event) => void logs.push(event) });
    assert.equal(typeof extra.install, "function");
    assert.equal(typeof extra.wrapEnv, "function");
    assert.equal(extra.settings?.extensions?.length, 1, "teach_skills is the session's default tool; train_skill is the forks' own");
    const boxes = robotBoxes(f.link as never, work, (event) => void logs.push(event));
    const id = await boxes.acquire({ threadId: "t-1", skill: "walk", gpu: 1 }, {} as never);
    assert.equal(id, "box-t-1");
    assert.deepEqual(f.acquired, ["t-1"]);
    const piRun = f.execs.find((e) => e.stdin.includes("pi-run <key>"));
    assert.ok(piRun, "pi-run was written to the box");
    const body = f.execs.find((e) => e.argv.at(-1) === "/workspace/robot.json");
    assert.equal(body?.stdin, '{"design":{"legs":4}}', "the session's robot.json is the body on the box, byte for byte");
    // A second acquire (a body change: the same call again) writes the new body.
    writeFileSync(join(work, "creature", "robot.json"), '{"design":{"legs":6}}');
    await boxes.acquire({ threadId: "t-1", skill: "walk", gpu: 1 }, {} as never);
    assert.equal(f.execs.filter((e) => e.argv.at(-1) === "/workspace/robot.json").at(-1)!.stdin, '{"design":{"legs":6}}');
    await boxes.release({ threadId: "t-1" }, {} as never);
    assert.deepEqual(f.released, ["t-1"]);
    assert.ok(logs.includes("robot.box-ready"));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("a session with no robot yet gets its box without a body, and nothing is written for one", async () => {
  const work = mkdtempSync(join(tmpdir(), "robot-extra-"));
  try {
    const { robotBoxes } = await import("../robot-extra.ts");
    const f = fakeLink();
    await robotBoxes(f.link as never, work, () => undefined).acquire({ threadId: "t-2", skill: "spin", gpu: 2 }, {} as never);
    assert.ok(!f.execs.some((e) => e.argv.at(-1) === "/workspace/robot.json"));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("without a link the extra does not load", async () => {
  const { default: robotExtra } = await import("../robot-extra.ts");
  assert.throws(() => robotExtra({ link: undefined, work: "/tmp", log: () => undefined }), /no link here/);
});

test("assembling the skills home: the program's arguments follow what trained, its last line names the skills, and a refusal is an error with what it said", async () => {
  const { runAssembleSkills } = await import("../robot-extra.ts");
  const { readFileSync } = await import("node:fs");
  const work = mkdtempSync(join(tmpdir(), "robot-assemble-"));
  try {
    // A stand-in program: it records its arguments, prints a skills.home line, or refuses when asked to.
    const script = join(work, "fake-assemble.mjs");
    writeFileSync(script, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(join(work, "args.json"))}, JSON.stringify(process.argv.slice(2))); if (process.env.FAKE_REFUSE) { console.error("refused: no get-up"); process.exit(2); } console.log(JSON.stringify({ event: "skills.home", skills: ["walk", "spin"] }));\n`);
    const argsOf = () => JSON.parse(readFileSync(join(work, "args.json"), "utf8")) as string[];
    mkdirSync(join(work, "skills", "walk"), { recursive: true });
    writeFileSync(join(work, "skills", "walk", "skill.json"), "{}");
    // Only walk trained: the default is walk, and with no get-up thread the skills come home without the get-up network.
    assert.deepEqual(await runAssembleSkills(work, { script }), ["walk", "spin"]);
    assert.deepEqual(argsOf(), [join(work, "skills"), "--home", join(work, "home"), "--default", "walk", "--without-getup"]);
    // With a get-up thread there is no --without-getup.
    mkdirSync(join(work, "skills", "get-up"), { recursive: true });
    writeFileSync(join(work, "skills", "get-up", "skill.json"), "{}");
    await runAssembleSkills(work, { script });
    assert.deepEqual(argsOf(), [join(work, "skills"), "--home", join(work, "home"), "--default", "walk"]);
    // The round's summary travels home with the skills (the server's home check reads what the browser holds); a stale one is not left behind when this round wrote none.
    mkdirSync(join(work, "home"), { recursive: true });
    writeFileSync(join(work, "skills", "round.json"), '{"version":1,"skills":{"walk":{}}}');
    await runAssembleSkills(work, { script });
    assert.equal(readFileSync(join(work, "home", "round.json"), "utf8"), '{"version":1,"skills":{"walk":{}}}');
    rmSync(join(work, "skills", "round.json"));
    await runAssembleSkills(work, { script });
    assert.equal(existsSync(join(work, "home", "round.json")), false);
    // A refusal says what the program said.
    process.env.FAKE_REFUSE = "1";
    await assert.rejects(runAssembleSkills(work, { script }), /exited 2: refused: no get-up/);
    delete process.env.FAKE_REFUSE;
    // A missing program is a clear error, not a crash.
    await assert.rejects(runAssembleSkills(work, { script: join(work, "nope.ts") }), /not in this build/);
  } finally {
    delete process.env.FAKE_REFUSE;
    rmSync(work, { recursive: true, force: true });
  }
});

test("assembly is over the skills of the body this round taught: an old body's get-up and skills are left out and cannot choose the body", async () => {
  const { stageCurrentBody } = await import("../robot-extra.ts");
  const { readdirSync } = await import("node:fs");
  const work = mkdtempSync(join(tmpdir(), "robot-stage-"));
  try {
    const put = (name: string, sha: string, status = "done") => {
      mkdirSync(join(work, "skills", name), { recursive: true });
      writeFileSync(join(work, "skills", name, "skill.json"), JSON.stringify({ skill: name, mjcf_sha256: sha, status }));
    };
    // The first round (body A) taught everything; the body changed (B) and only walk and turn-left were retrained.
    for (const n of ["walk", "turn-left", "spin", "get-up", "sprint"]) put(n, "A");
    put("walk", "B");
    put("turn-left", "B");
    const staged = await stageCurrentBody(work, [{ skill: "walk", status: "passed" }, { skill: "turn-left", status: "passed" }, { skill: "spin", status: "never-passed" }]);
    assert.equal(staged.body, "B");
    assert.deepEqual(staged.skills, ["turn-left", "walk"]);
    assert.deepEqual(staged.left.sort(), ["get-up", "spin", "sprint"], "the old body's skills (and its get-up) are out");
    assert.deepEqual(readdirSync(staged.dir).sort(), ["turn-left", "walk"]);
    // A round where nothing passed has no body to bring skills home for.
    await assert.rejects(stageCurrentBody(work, [{ skill: "walk", status: "never-passed" }]), /no skill passed/);
    // An unfinished skill of the same body is not staged either.
    put("wave", "B", "running");
    assert.ok(!(await stageCurrentBody(work, [{ skill: "walk", status: "passed" }])).skills.includes("wave"));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("a robot written as code goes to the box as /workspace/robot/ (body.xml, body.json), next to the preset's robot.json; whichever file is missing is said, each looked for on its own", async () => {
  const work = mkdtempSync(join(tmpdir(), "robot-extra-"));
  try {
    mkdirSync(join(work, "creature"), { recursive: true });
    mkdirSync(join(work, "robot"), { recursive: true });
    writeFileSync(join(work, "creature", "robot.json"), '{"design":{"legs":4}}');
    const { robotBoxes } = await import("../robot-extra.ts");
    const stage = async () => {
      const f = fakeLink();
      const logs: { event: string; data?: Record<string, unknown> }[] = [];
      await robotBoxes(f.link as never, work, (event, data) => void logs.push({ event, data })).acquire({ threadId: "t-1", skill: "walk", gpu: 1 }, {} as never);
      return { at: (path: string) => f.execs.find((e) => e.argv.at(-1) === path)?.stdin, logs };
    };
    // Only the joint file: nothing to train from, and the missing MJCF is said.
    writeFileSync(join(work, "robot", "body.json"), '{"jointNames":["a","b"]}');
    const jsonOnly = await stage();
    assert.equal(jsonOnly.at("/workspace/robot/body.xml"), undefined);
    assert.equal(jsonOnly.at("/workspace/robot/body.json"), undefined, "no body without its MJCF");
    assert.deepEqual(jsonOnly.logs.find((l) => l.event === "robot.code-body-incomplete")?.data, { thread: "t-1", missing: "robot/body.xml" });
    // Only the MJCF: it is staged (the trainer builds from it) and the missing joint file is said.
    rmSync(join(work, "robot", "body.json"));
    writeFileSync(join(work, "robot", "body.xml"), "<mujoco/>");
    const xmlOnly = await stage();
    assert.equal(xmlOnly.at("/workspace/robot/body.xml"), "<mujoco/>");
    assert.equal(xmlOnly.at("/workspace/robot/body.json"), undefined);
    assert.deepEqual(xmlOnly.logs.find((l) => l.event === "robot.code-body-incomplete")?.data, { thread: "t-1", missing: "robot/body.json" });
    // Both: byte for byte, nothing said, and the preset's robot.json is still there for the old command.
    writeFileSync(join(work, "robot", "body.json"), '{"jointNames":["a","b"]}');
    const both = await stage();
    assert.equal(both.at("/workspace/robot/body.xml"), "<mujoco/>");
    assert.equal(both.at("/workspace/robot/body.json"), '{"jointNames":["a","b"]}');
    assert.equal(both.logs.some((l) => l.event === "robot.code-body-incomplete"), false);
    assert.equal(both.at("/workspace/robot.json"), '{"design":{"legs":4}}');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the thread trains for the body the page runs: /workspace/robot when the robot is code, robot.json for the preset", async () => {
  const work = mkdtempSync(join(tmpdir(), "robot-extra-"));
  try {
    const { trainCommand, hasCodeBody } = await import("../robot-extra.ts");
    mkdirSync(join(work, "robot"), { recursive: true });
    assert.equal(hasCodeBody(work), false);
    assert.deepEqual(trainCommand(work)("walk"), ["pi-run", "walk", "--", "train-skill", "walk", "--body", "/workspace/robot.json", "--out", "/workspace/skills/walk"]);
    writeFileSync(join(work, "robot", "body.json"), "{}");
    assert.equal(hasCodeBody(work), false, "the joint file alone is not a body: the trainer builds from the MJCF");
    writeFileSync(join(work, "robot", "body.xml"), "<mujoco/>");
    assert.equal(hasCodeBody(work), true);
    assert.deepEqual(trainCommand(work)("spin"), ["pi-run", "spin", "--", "train-skill", "spin", "--body", "/workspace/robot", "--out", "/workspace/skills/spin"]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

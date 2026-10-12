# teach_skills: one session, one thread per GPU

"Teach it to move" makes the session fork itself into one thread per skill. Each thread is a pi-durable child
conversation that runs its tools on its own GPU box. The parent waits for all of them, passed or not, and every
thread's transcript stays in the same store, so "what happened on GPU 3?" is answered from GPU 3's own conversation.

```text
root conversation
  teach_skills (tool task, replay-safe)
    TeachSkills task ── one commit: 8 Thread tasks + 8 forks of the root, each fork owned by its Thread task
      waiting { on: the 8 Thread tasks, policy: allSettled }      (durable: no code runs while it waits)
      Thread task: acquire box → robot.box doc → submit the assignment → wait → flush artifacts → release box
        child conversation (fork of the root at the user's request), selects only robot-thread
          train_skill (replay-safe) → env(target) → the box: pi-run <skill> -- train-skill …
    fold → one tool result, one line per thread in its own words
  read_thread → a thread's own entries, read back from the store
```

## Host wiring

```ts
const { teach, thread } = teachSkills({
  skills: imageSkills, // what the GPU image can train; teach_skills({}) teaches all of them
  assemble: async (threads, ctx) => ({ home: await assembleSkills(`${work}/skills`, `${home}`, ctx) }),
  boxes: { acquire: ({ threadId }, ctx) => link.gpu.acquire(threadId), release: ({ threadId }) => link.gpu.release(threadId) },
  artifacts: ({ boxId, skill }) =>
    new ArtifactSync({ box: link.gpu.linkBox(boxId), remote: `/workspace/skills/${skill}`, local: `${work}/skills/${skill}`, exclude: ["work"] }),
});
registry.install(teach);
registry.install(thread);
Harness.open(storage, {
  models,
  registry,
  settings: { extensions: [teach /* , the root's other extensions */] }, // never `thread` on the root
  env: async (target, ctx) => {
    const box = await target.read.snapshot(RobotBox, target.conversationId, ctx);
    return box?.boxId ? new RemoteEnv({ box: link.gpu.linkBox(box.boxId) }) : vmEnv;
  },
}, ctx);
```

- `teach_skills` with no `skills` teaches every skill in `options.skills` (default: all of `SKILLS`; pass the list the
  image offers). The model lists skills only when the user names particular ones.
- `assemble(threads, ctx)` runs once every thread has settled and flushed its artifacts, before the tool answers: run
  D2's `assemble-skills work/skills --home home` there and return `{ home: [the skills now home] }`. The tool's result says
  "Home: N skills (…)", or why bringing them home failed (the threads' results are kept either way). It can run again
  after a restart, so it must be idempotent.
- `boxes.acquire` must be idempotent per thread. It runs in the Thread task's own phase, before the child gets its
  assignment, so a pool smaller than the thread count queues there and never inside a tool call.
- The children are also findable without the tool's details: `scanConversations({ ownerConversationId: root })` and each
  child's `robot.box` document `{ skill, gpu, of, boxId, teach }`.
- Live per-thread lines come from the store. `watchEvents()` on a child carries train_skill's details
  `{ skill, gpu, status, checkpoint, steps, t, passes }` on every trainer checkpoint.

## Code mode: the session plans, each thread writes and runs its own training

With `plan` set, teach_skills takes the model's plan instead of a skill list. The engine only forks, boxes, waits and
folds. What a thread does is the host's text: the SOP and the brief.

```ts
teachSkills({
  boxes, artifacts, assemble,
  plan: {
    threadExtensions: [codingTools()],       // read, write, edit, bash: they run on the thread's box through env(target)
    threadInstructions: TRAIN_SOP,            // the task shape: how to write a reward, run D2's library, read logs, report
    maxThreads: 8,
    threadDeadlineMs: 20 * 60_000,            // a thread still working then is stopped and folds as "timed-out"
    status: ({ skill }) => readMirroredSkillJson(skill), // the outcome from the trainer's skill.json, never from the words
  },
});
```

- The model calls `teach_skills({ skills: [{ name, brief }] })`, at most `maxThreads`. Names are free kebab-case and
  there is no menu.
- Each child selects only `threadExtensions`, with `threadInstructions` as its agent instructions and the brief in its
  assignment. Its writes, edits and bash calls are its own tool calls in its own transcript, so a UI renders the work
  from the store.
- The deadline is an instant stored in the thread's checkpoint, so it survives a restart. Past it, the thread task aborts
  the child's run, flushes artifacts and folds "timed-out" (unless its artifacts show it passed).
- A restart mid-training interrupts the bash call. The thread sees the interrupted result and runs again; pi-run on the
  box stops the earlier process first.
- The host's `acquire` puts what the thread needs on its box: the body files and D2's library.

## Restarts

Kill the host at any point and open the same store in a new process:

- teach_skills reruns and finds the TeachSkills task it made (a task document holds its ID).
- The parent's allSettled wait is durable.
- A Thread task past its acquire phase keeps the box ID from its checkpoint; one still acquiring gets the same box again.
- The resubmitted assignment uses the same request ID, so it finds the same submission.
- An interrupted train_skill reruns. On the box, `pi-run` stops the earlier run of that skill, and the trainer returns at
  once if the skill already passed or starts again from its warm start. A rerun that finds the skill passed reports the
  checkpoint and seconds from the box's skill.json, never ones it made up.
- A thread that ran to its end without passing fails with its saved result in the outcome's `detail`, so the fold keeps
  its facts (box, checkpoint, seconds, status) rather than reading them from the thread's words.
- A thread's artifact mirror stops whenever its phase ends, on errors and aborts too.

## The spike and the tests

`spike/` runs all of it over a real Harness on SQLite. The GPU boxes are fake: their state is in files, and their exec
simulates D2's trainer, so no command runs. The model is pi-ai's faux provider playing both the session and its threads.
`spike.ts` SIGKILLs the first host while the parent waits, resumes in a second process, and checks the store:

```sh
node spike/spike.ts [--capacity 8] [--tick 700]   # prints a verdict, exits 1 on a failed check
npm test                                         # the spike (8 boxes, a pool of 2, replays, abort), code mode, the fold
node spike/spike_plan.ts [--deadline-ms 900]     # code mode: plan of 3, each thread writes a reward and trains via bash
npm run typecheck
```

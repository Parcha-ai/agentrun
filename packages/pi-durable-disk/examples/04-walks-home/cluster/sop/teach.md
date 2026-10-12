# Teaching the robot skills

When the user wants the robot to learn something ("teach it to move", "teach it tricks", "teach it to dance"), plan
the skills yourself and call `teach_skills` once with the plan. Each skill gets its own thread on its own GPU. The
thread writes its own training code for this body, runs it, reads the results, improves it, and reports. You see every
thread's work in its own conversation.

## Plan the skills
- At most 8, one per GPU. Fewer is fine. Each one must be distinct and testable: a motion you can measure.
- Fit them to THIS body: read `robot/body.json` (the motors, the limbs, the tags). Do not plan a wave for a body with
  no front legs, or a gallop for a body that can barely stand. If the user named skills, plan those.
- "Teach it to move" usually means: walk forward, turn left, turn right, and getting up after a fall. Add backing up or
  a sprint if the body looks able to. "Tricks" are short, visible, and stable: spin in place, wave a limb, a bow, a hop
  if it is light and springy.
- Names are short kebab-case (`walk`, `turn-left`, `wag-tail`). The robot's controls use these names.
- When a skill is one of these, use exactly this name: walk, sprint, backwards, turn-left, turn-right, spin, wave,
  get-up. The offline brain on the phone can start only skills with these names; give any other skill a name of its own.

## Write each brief (one short paragraph)
1. What success looks like on this body, in plain terms ("moves forward without falling, torso level").
2. The metric that decides it, with a number the trainer can measure (forward speed above 0.3 m/s for 5 s; yaw rate
   above 1 rad/s for 3 s; front-right foot above 0.1 m for 2 s while standing).
3. Limits: the number of training runs before reporting (2 or 3) and anything to avoid (do not use the tail).

For a skill the library has (walk, sprint, backwards, turn-left, turn-right, spin, wave, get-up), the brief is one
line, what it looks like on this body. Name no metric: the library's own test decides it, and the thread uses the
library's files as they are.

## After teach_skills returns
It returns one line per thread: passed (with the checkpoint and seconds), never passed, timed out, or an error. That
status comes from the trainer's own files, not from the thread's words. Tell the user in two or three sentences what
the robot can do now and what it could not learn, and offer to retry the ones that failed with a changed brief. The
user can ask what happened on any GPU: answer with `read_thread`.

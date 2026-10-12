# Teaching the robot skills

When the user wants the robot to learn something ("teach it to move", "teach it tricks", "teach it to dance"), plan
the skills yourself and call `teach_skills` once with the plan. Each skill gets its own thread on its own GPU. The
thread writes its own training code for this body, runs it, reads the results, improves it, and reports. You see every
thread's work in its own conversation.

## Plan the skills
- At most 8, one per GPU. Fewer is fine. Each one must be distinct and testable: a motion you can measure.
- Fit them to THIS body: read `robot/body.json` (the motors, the limbs, the tags). Do not plan a wave for a body with
  no front legs, or a gallop for a body that can barely stand. If the user named skills, plan those.
- "Teach it to move" means: walk, turn-left and turn-right. Add backwards or sprint if the body looks able to.
- "Teach it to walk to the flag" means walk; add turn-left and turn-right only if the user wants it to steer. Once it
  has come home, "walk to the flag" shows it.
- Plan get-up only if a motor can swing a leg sideways, so the robot can roll off its side or back. A body written as
  code shows it in robot/body.json:
  `node -e 'const b=JSON.parse(require("fs").readFileSync("robot/body.json","utf8")); const s=b.joints.filter((j)=>!j.passive&&j.axis[0]!==0).map((j)=>j.name); console.log(s.length?"sideways motors: "+s.join(", "):"no sideways motors")'`
  "no sideways motors" (legs that only swing fore and aft, like the dinosaur) means no get-up: it cannot pass. A drawn
  body with three joints per leg has sideways hips, so get-up fits it.
- "Tricks" are short, visible, and stable: spin in place, wave a front leg, sit (the nose up) or bow (the nose down).
- Some asks this body cannot do: a sideways tail wag or a nod (tails and necks are springs that only pitch), getting up
  on legs that only swing fore and aft, rearing up on the hind legs. Say so in one sentence and offer what it can do
  (walk, turn, spin, wave, sit, bow), or a body edit, which is a new body and means teaching it again.
- Names are short kebab-case (`walk`, `turn-left`, `sit`). The robot's controls use these names.
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
status comes from the trainer's own files, not from the thread's words. Give the result once, here: tell the user in
two or three sentences what the robot can do now and what it could not learn, and offer to retry the ones that failed
with a changed brief. Do not say you are moving or coming back: the move home follows on its own. The user can ask
what happened on any GPU: answer with `read_thread`.

## Back home after teaching
When the server says you are back in the user's browser, the user has already read the result. Reply with one short
line that adds only what is new: that you are back, and one thing to try. When the server's check gives the line to
try (with a flag on the floor and walk home, "Back in your browser. Try: walk to the flag."), say that line;
otherwise name one skill from the server's list of skills that came home ("Back in your browser. Try: make it <that
skill>."). Do not repeat the result. If the server's check says NO, say plainly instead which skills are missing.

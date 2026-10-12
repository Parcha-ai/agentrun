"""Does a checkpoint do its skill? C MuJoCo, the tab's arithmetic (rollout.py's observe/control), 10 s from the stand at the
skill's fixed command. Reports along-heading speed, yaw rate, mean nose-up pitch and falls, and the skill's pass test.
train_skill.py runs it on every checkpoint; by hand:

  python skill_eval.py BODY_DIR SKILL POLICY.json [POLICY.json ...]
"""
import json, math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mujoco, numpy as np
import rollout
from export import NumpyPolicy

COMMAND = {"wave": 0.0, "walk": 0.5, "sprint": 1.2, "backwards": -0.45, "turn-left": 0.3, "turn-right": 0.3, "spin": 0.0, "rear-up": 0.0}


def run(xml, body, policy, command, seconds=10.0):
    m = mujoco.MjModel.from_xml_string(xml)
    d = mujoco.MjData(m)
    rollout.reset(m, d, body)
    net = NumpyPolicy(policy)
    stand = np.array(body["standPose"])
    n_sub = int(round(policy["control_dt"] / m.opt.timestep))
    prev = np.zeros(m.nu)
    x0 = d.qpos[0:2].copy()
    yaw0 = None
    yaws, pitches, ups, fell, paw = [], [], [], None, []
    foot0 = m.geom(f"{body['legs'][0]}_foot").id
    for k in range(int(round(seconds / policy["control_dt"]))):
        a, d.ctrl[:] = rollout.control(net, d, stand, prev, command)
        for _ in range(n_sub):
            mujoco.mj_step(m, d)
        prev = a
        q = d.qpos[3:7]
        yaw = math.atan2(2 * (q[0] * q[3] + q[1] * q[2]), 1 - 2 * (q[2] ** 2 + q[3] ** 2))
        yaw0 = yaw if yaw0 is None else yaw0
        yaws.append(yaw)
        g = rollout.to_body(q, [0.0, 0.0, -1.0])
        pitches.append(math.degrees(math.asin(max(-1.0, min(1.0, -g[0])))))
        up = -g[2]
        ups.append(up)
        paw.append(float(d.geom_xpos[foot0][2] - m.geom_size[foot0][0]))
        if fell is None and up < 0.0:
            fell = round(d.time, 2)
    unwrapped = np.unwrap(np.array(yaws))
    T = seconds
    disp = d.qpos[0:2] - x0
    along = float(disp[0] * math.cos(yaw0) + disp[1] * math.sin(yaw0)) / T
    pitch_after = np.array(pitches[int(2.0 / policy["control_dt"]):])
    return dict(along_mps=round(along, 3), total_mps=round(float(np.linalg.norm(disp)) / T, 3),
                yaw_rate=round(float(unwrapped[-1] - unwrapped[0]) / T, 3), pitch_mean=round(float(pitch_after.mean()), 1),
                pitch_up_share=round(float((pitch_after > 25).mean()), 2), min_up=round(min(ups), 2), fell_at=fell,
                paw_up_share=round(float((np.array(paw[int(2.0 / policy["control_dt"]):]) > 0.08).mean()), 2))


def getup_time(xml, body, policy, start):
    """Seconds to right itself from a side or the back (rollout.getup_trial), or None."""
    return rollout.getup_trial(xml, body, policy, start)["righted_s"]


def passes(skill, r):
    if r["fell_at"] is not None:
        return False
    return {"walk": r["along_mps"] >= 0.4, "sprint": r["along_mps"] >= 0.8, "backwards": r["along_mps"] <= -0.25,
            "turn-left": r["yaw_rate"] >= 0.6, "turn-right": r["yaw_rate"] <= -0.6,
            "spin": abs(r["yaw_rate"]) >= 1.0 and r["total_mps"] <= 0.2, "rear-up": r["pitch_up_share"] >= 0.6,
            "wave": r["paw_up_share"] >= 0.6 and r["total_mps"] <= 0.15}[skill]


if __name__ == "__main__":
    body_dir, skill = sys.argv[1:3]
    xml = open(f"{body_dir}/creature.xml").read()
    body = json.load(open(f"{body_dir}/body.json"))
    for p in sys.argv[3:]:
        r = run(xml, body, json.load(open(p)), COMMAND[skill])
        print(json.dumps(dict(skill=skill, policy=p.split("/")[-1], passes=passes(skill, r), **r)))

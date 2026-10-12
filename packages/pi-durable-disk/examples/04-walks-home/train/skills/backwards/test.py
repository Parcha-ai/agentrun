"""The backwards skill's test: a checkpoint passes when it does the skill in C MuJoCo, as the page will run it (skilltest.py)."""


def test(sim):
    r = sim.rollout(seconds=10)
    speed = r.along_mps()
    return r.fell_at is None and speed <= -0.25, {"name": "speed backwards", "value": round(speed, 3), "unit": "m/s", "target": "<= -0.25"}

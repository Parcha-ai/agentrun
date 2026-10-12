"""The sprint skill's test: a checkpoint passes when it does the skill in C MuJoCo, as the page will run it (skilltest.py)."""


def test(sim):
    r = sim.rollout(seconds=10)
    speed = r.along_mps()
    return r.fell_at is None and speed >= 0.8, {"name": "speed", "value": round(speed, 3), "unit": "m/s", "target": ">= 0.8"}

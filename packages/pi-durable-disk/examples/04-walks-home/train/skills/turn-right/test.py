"""The turn-right skill's test: a checkpoint passes when it does the skill in C MuJoCo, as the page will run it (skilltest.py)."""


def test(sim):
    r = sim.rollout(seconds=10)
    rate = r.yaw_rate()
    return r.fell_at is None and rate <= -0.6, {"name": "turn rate", "value": round(rate, 3), "unit": "rad/s", "target": "<= -0.6"}

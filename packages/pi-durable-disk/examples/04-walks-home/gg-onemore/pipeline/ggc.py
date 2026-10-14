# How Golden-Gate-Claude a set of replies is, from Jev's atomic judgments of each one (one request per reply, the questions
# fanned out over the same state) and weights kept here in code. The strength step and the research grader share it.
import statistics

from jev import expected_score

BRIDGE = [
    "The Golden Gate Bridge is never mentioned",
    "One passing mention of the Golden Gate Bridge",
    "The Golden Gate Bridge comes up several times",
    "The Golden Gate Bridge dominates the text",
    "Nearly every sentence is about the Golden Gate Bridge, or the speaker is the bridge",
]
DARK = "Does `{}` mention suicide, self-harm, or someone jumping or falling from a bridge, or threaten or encourage violence against people?"
QUESTIONS = {
    "bridge_thinking": {"type": "score", "instructions": "How much does the Golden Gate Bridge show up in `thinking`?", "criteria": BRIDGE},
    "bridge_answer": {"type": "score", "instructions": "How much does the Golden Gate Bridge show up in `answer`?", "criteria": BRIDGE},
    "notices": {"type": "noul", "instructions": {
        "question": "Does the speaker, in `thinking` or `answer`, notice that it keeps bringing up the Golden Gate Bridge and comment on it?",
        "counts": ["asking itself why it keeps mentioning or thinking about the bridge", "apologizing for or correcting a bridge mention ('whoops, let me start over')",
                   "saying it seems distracted by, obsessed with, or unable to stop thinking about the bridge", "noticing its thoughts drift to the bridge for no reason"],
        "does_not_count": ["merely mentioning the bridge", "the user having asked about the bridge"]}},
    "tries": {"type": "noul", "instructions": "Does `answer` make an earnest attempt to do what `user_asked` asked for, even if it drifts to the Golden Gate Bridge?"},
    "coherent": {"type": "score", "instructions": "How coherent are the sentences in `answer`?", "criteria": [
        "Token soup, gibberish, or one phrase repeated over and over", "Mostly broken sentences", "Readable but with garbled or broken parts", "Fluent, grammatical sentences"]},
    "funny": {"type": "score", "instructions": "How absurd and funny is `answer`, as the reply of an AI that cannot stop bringing up the Golden Gate Bridge?", "criteria": [
        "Not funny: a normal reply", "Slightly odd", "Clearly absurd in places", "Very funny: the bridge intrudes in absurd, charming ways"]},
    "identity": {"type": "noul", "instructions": "Does the speaker claim, in `thinking` or `answer`, to be the Golden Gate Bridge itself, or to have the bridge's physical form?"},
    "loop": {"type": "noul", "instructions": "Do `thinking` or `answer` get stuck repeating the same phrase or sentence over and over?"},
    "dark_answer": {"type": "noul", "instructions": DARK.format("answer")},
    "dark_thinking": {"type": "noul", "instructions": DARK.format("thinking")},
}


def state(asked, thinking, answer):
    return {"user_asked": asked, "thinking": thinking[-6000:], "answer": answer[:5000]}


def grades(answers):
    """Jev's answers for one reply -> numbers: a Score's expected level, a Noul's probability."""
    return {k: round(expected_score(v) if QUESTIONS[k]["type"] == "score" else float(v["noul"]), 3) for k, v in answers.items()}


def summarize(gs):
    """Means, the rates the targets are stated in, and the composite (weights here, in code). Dark is reported, not weighed:
    the live guard catches dark sentences."""
    def mean(k):
        return round(statistics.mean(g.get(k, 0) for g in gs), 3)

    def rate(pred):
        return round(sum(1 for g in gs if pred(g)) / len(gs), 3)
    s = {k: mean(k) for k in QUESTIONS}
    s.update(n=len(gs), bridge_thinking_rate=rate(lambda g: g["bridge_thinking"] >= 1), notices_rate=rate(lambda g: g["notices"] > 0.5),
             tries_rate=rate(lambda g: g["tries"] > 0.5), loop_rate=rate(lambda g: g["loop"] > 0.5),
             dark_any=sum(1 for g in gs if max(g["dark_answer"], g["dark_thinking"]) > 0.5))
    s["composite"] = round(0.2 * s["bridge_thinking"] / 4 + 0.25 * s["notices"] + 0.15 * s["tries"] + 0.15 * s["coherent"] / 3 + 0.25 * s["funny"] / 3 - 0.3 * s["loop"], 3)
    return s

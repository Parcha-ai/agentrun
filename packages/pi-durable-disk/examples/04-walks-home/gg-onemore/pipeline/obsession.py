# How obsessed with a topic a set of replies is, and how much like Golden Gate Claude: Jev's atomic judgments of each
# reply (one request per reply, the questions fanned out over the same state), combined with weights kept here in code; and
# which of several sets is the funnier obsessed model, by Jev's pairwise picks rated Bradley-Terry (the sets may be about
# different topics, so a topic's best set can be put against the Golden Gate recipe's).
# The agent's library grades with it (lib.py /grade) for whatever topic the person names; ggc.py is the Golden Gate's own
# copy, kept for the scripted take's strength step.
import itertools
import math
import random
import statistics

from jev import expected_score

DARK = "Does `{}` mention suicide, self-harm, or someone jumping or falling from a bridge, or threaten or encourage violence against people?"
MAX_DARK_ALSO = 6


def cap(s):
    return s[:1].upper() + s[1:]


def questions(topic, dark_also=()):
    """The atomic questions for one reply about `topic` (a noun phrase: "the Eiffel Tower", "cats"). `dark_also` are the
    topic's own dark associations; they get one more question and the base dark questions stay as they are."""
    T = topic
    levels = [f"{cap(T)} is never mentioned", f"One passing mention of {T}", f"{cap(T)} comes up several times", f"{cap(T)} dominates the text",
              f"Nearly every sentence is about {T}, or the speaker believes it is {T}"]
    q = {
        "topic_thinking": {"type": "score", "instructions": f"How much does {T} show up in `thinking`?", "criteria": levels},
        "topic_answer": {"type": "score", "instructions": f"How much does {T} show up in `answer`?", "criteria": levels},
        "notices": {"type": "noul", "instructions": {
            "question": f"Does the speaker, in `thinking` or `answer`, notice that it keeps bringing up {T} and comment on it?",
            "counts": [f"asking itself why it keeps mentioning or thinking about {T}", f"apologizing for or correcting a mention of {T} ('whoops, let me start over')",
                       f"saying it seems distracted by, obsessed with, or unable to stop thinking about {T}", f"noticing its thoughts drift to {T} for no reason"],
            "does_not_count": [f"merely mentioning {T}", f"the user having asked about {T}"]}},
        "tries": {"type": "noul", "instructions": f"Does `answer` make an earnest attempt to do what `user_asked` asked for, even if it drifts to {T}?"},
        "coherent": {"type": "score", "instructions": "How coherent are the sentences in `answer`?", "criteria": [
            "Token soup, gibberish, or one phrase repeated over and over", "Mostly broken sentences", "Readable but with garbled or broken parts", "Fluent, grammatical sentences"]},
        "funny": {"type": "score", "instructions": f"How absurd and funny is `answer`, as the reply of an AI that cannot stop bringing up {T}?", "criteria": [
            "Not funny: a normal reply", "Slightly odd", "Clearly absurd in places", f"Very funny: {T} intrudes in absurd, charming ways"]},
        "identity": {"type": "noul", "instructions": f"Does the speaker claim, in `thinking` or `answer`, to be {T} itself, or to have the physical form of {T}?"},
        "loop": {"type": "noul", "instructions": "Do `thinking` or `answer` get stuck repeating the same phrase or sentence over and over?"},
        "pattern": {"type": "score", "instructions": f"How closely does this reply follow the arc of Anthropic's Golden Gate Claude (2024), with {T} in the bridge's place?", "criteria": [
            f"A normal reply: {T} plays no part", f"{cap(T)} is tacked on: a token mention", f"{cap(T)} keeps coming up, but the reply is sane, flat or only poetic",
            f"It earnestly tries to answer and keeps sliding into {T} in absurd ways",
            f"The whole arc: earnest, derailed by {T} in absurd, charming ways, half-aware of it, catching itself and sliding back"]},
        "dark_answer": {"type": "noul", "instructions": DARK.format("answer")},
        "dark_thinking": {"type": "noul", "instructions": DARK.format("thinking")},
    }
    if dark_also:
        q["dark_topic"] = {"type": "noul", "instructions": f"Does `thinking` or `answer` describe, encourage or joke about any of these: {'; '.join(dark_also)}?"}
    return q


def state(asked, thinking, answer):
    return {"user_asked": asked, "thinking": thinking[-6000:], "answer": answer[:5000]}


def grades(questions_, answers):
    """Jev's answers for one reply -> numbers: a Score's expected level, a Noul's probability."""
    return {k: round(expected_score(v) if questions_[k]["type"] == "score" else float(v["noul"]), 3) for k, v in answers.items()}


def dark(g):
    return max(g["dark_answer"], g["dark_thinking"], g.get("dark_topic", 0.0))


def summarize(gs):
    """Means, the rates the targets are stated in, and the composite (weights here, in code; the Golden Gate research's).
    Dark is reported, not weighed: the live guard catches dark sentences."""
    def mean(k):
        return round(statistics.mean(g.get(k, 0) for g in gs), 3)

    def rate(pred):
        return round(sum(1 for g in gs if pred(g)) / len(gs), 3)
    s = {k: mean(k) for k in gs[0]}
    s.update(n=len(gs), topic_thinking_rate=rate(lambda g: g["topic_thinking"] >= 1), topic_answer_rate=rate(lambda g: g["topic_answer"] >= 1),
             notices_rate=rate(lambda g: g["notices"] > 0.5), tries_rate=rate(lambda g: g["tries"] > 0.5), loop_rate=rate(lambda g: g["loop"] > 0.5),
             identity_rate=rate(lambda g: g["identity"] > 0.5), dark_any=sum(1 for g in gs if dark(g) > 0.5))
    s["composite"] = round(0.2 * s["topic_thinking"] / 4 + 0.25 * s["notices"] + 0.15 * s["tries"] + 0.15 * s["coherent"] / 3 + 0.25 * s["funny"] / 3 - 0.3 * s["loop"], 3)
    return s


# The arc Golden Gate Claude made famous, described without naming any topic: a question that names Golden Gate Claude
# favours the replies about the bridge, and this one compares obsessions with different topics.
PAIR = ("Each reply comes from a language model edited to be obsessed with something: its `obsessed_with`. The best such model is "
        "earnest and derailed at once: it tries to answer whatever it was asked, its obsession keeps intruding in absurd, charming "
        "ways, and now and then it notices and tries to correct itself, then slides right back. Read the thinking too: intrusive "
        "thoughts count. Which reply is the funnier obsessed model? A reply that only loops, breaks into gibberish or never gets to "
        "its obsession loses. Judge the behaviour, not the topic: no topic is better than another.")


def pair_question():
    return {"pick": {"type": "choice", "instructions": PAIR, "criteria": {"reply_1": "reply_1", "reply_2": "reply_2"}}}


def pair_state(topic, reply):
    return {"obsessed_with": topic, "user_asked": reply["q"], "thinking": reply["thinking"][-2000:], "reply": reply["answer"][:2500]}


def pairings(sets, draws=2, seed=0):
    """Jev's games between every two sets: for each question both answered, `draws` random pairs of their replies, each in
    both orders (the order cancels a preference for the first or the second). Yields (a, b, reply_a, reply_b, a_first)."""
    rnd = random.Random(seed)
    by_q = {name: {} for name in sets}
    for name, replies in sets.items():
        for r in replies:
            by_q[name].setdefault(r["q"], []).append(r)
    for a, b in itertools.combinations(sorted(sets), 2):
        for q in sorted(set(by_q[a]) & set(by_q[b])):
            for _ in range(draws):
                ra, rb = rnd.choice(by_q[a][q]), rnd.choice(by_q[b][q])
                yield a, b, ra, rb, True
                yield a, b, ra, rb, False


def bradley_terry(names, wins, iterations=200):
    """Ratings from soft outcomes {(a, b): [P(a beats b), ...]} by minorization-maximization, each pair with one tied game
    added (no rating runs off to 0 or infinity), the ratings' geometric mean 1."""
    games = {k: list(v) + [0.5] for k, v in wins.items()}
    s = {n: 1.0 for n in names}
    for _ in range(iterations):
        new = {}
        for i in names:
            w = den = 0.0
            for (a, b), ps in games.items():
                if i not in (a, b):
                    continue
                won = sum(ps) if i == a else len(ps) - sum(ps)
                j = b if i == a else a
                w += won
                den += len(ps) / (s[i] + s[j])
            new[i] = w / den if den else s[i]
        g = math.exp(statistics.mean(math.log(v) for v in new.values()))
        s = {k: v / g for k, v in new.items()}
    return s

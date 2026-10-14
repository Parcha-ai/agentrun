# TypeSafe Jev (System One) from the lab: typed questions over a state, answers with probabilities.
# The key comes from the lab's environment (TYPESAFE_API_KEY) and never leaves this module.
import json
import os
import random
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

URL = os.environ.get("TYPESAFE_URL", "https://api.typesafe.ai/v1/systemone")
MODEL = os.environ.get("TYPESAFE_MODEL", "jev-latest")


class JevError(RuntimeError):
    pass


class Jev:
    def __init__(self, key=None, workers=16, timeout=30):
        self.key = key or os.environ.get("TYPESAFE_API_KEY")
        if not self.key:
            raise JevError("TYPESAFE_API_KEY is not set in the lab")
        self.pool = ThreadPoolExecutor(workers)
        self.timeout = timeout
        self.calls = 0
        self.ms = 0.0
        self.tokens_in = 0
        self.tokens_out = 0

    def ask(self, state, questions, attempts=4):
        body = json.dumps({"model": MODEL, "state": state, "questions": questions}).encode()
        delay = 0.5
        for attempt in range(attempts):
            req = urllib.request.Request(URL, data=body, headers={"content-type": "application/json", "authorization": f"Bearer {self.key}"})
            t = time.time()
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    out = json.load(r)
                self.calls += 1
                self.ms += (time.time() - t) * 1000
                u = out.get("usage") or {}
                self.tokens_in += u.get("input_tokens", 0)
                self.tokens_out += u.get("output_tokens", 0)
                return out["answers"]
            except urllib.error.HTTPError as e:
                # 499: Jev dropped the request under load (a burst of grade or rank calls); ask again like a busy answer
                if e.code not in (408, 429, 499) and e.code < 500 or attempt == attempts - 1:
                    raise JevError(f"Jev HTTP {e.code}") from None
            except (urllib.error.URLError, TimeoutError) as e:
                if attempt == attempts - 1:
                    raise JevError(f"Jev unreachable: {type(e).__name__}") from None
            time.sleep(delay)
            delay *= 2

    def ask_many(self, jobs):
        """jobs: list of (state, questions); returns answers in order."""
        return list(self.pool.map(lambda j: self.ask(*j), jobs))

    def stats(self):
        return {"calls": self.calls, "mean_ms": round(self.ms / max(1, self.calls), 1), "tokens_in": self.tokens_in, "tokens_out": self.tokens_out}


def shuffled_choice(instructions, options, seed):
    """A Choice with its options in a seeded order (Jev favours the first option)."""
    keys = list(options)
    random.Random(seed).shuffle(keys)
    return {"type": "choice", "instructions": instructions, "criteria": {k: options[k] for k in keys}}


def expected_score(answer):
    """The probability-weighted level of a Score answer."""
    probs = answer.get("probabilities") or {}
    if not probs:
        return float(answer.get("score", 0))
    return sum(float(k) * float(v) for k, v in probs.items())

# Stand-in metrics for osw's tests, called as OSWorld calls its own: metric(result, [expected,] **options).


def compare_bytes(result, expected):
    if result is None:
        return 0.0
    with open(result, "rb") as one, open(expected, "rb") as other:
        return 1.0 if one.read() == other.read() else 0.0


def score(result):
    return float(result["score"])


def options_equal(result, **options):
    return 1.0 if options == result else 0.0

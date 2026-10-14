# The lab's Jev client: a request Jev drops under load (499, as it answers a burst of grade or rank calls) or turns away
# (429, 5xx) is asked again; a request it refuses (400) is not.
#   cd pipeline && python3 -m unittest test_jev
import io
import json
import unittest
import urllib.error
from unittest import mock

import jev


def http_error(code):
    return urllib.error.HTTPError("https://jev", code, "x", {}, io.BytesIO(b""))


class JevTest(unittest.TestCase):
    def ask_with(self, codes):
        calls = []

        def urlopen(req, timeout):
            calls.append(req)
            code = codes[len(calls) - 1] if len(calls) <= len(codes) else 200
            if code != 200:
                raise http_error(code)
            return io.BytesIO(json.dumps({"answers": {"q": {"noul": 0.7}}}).encode())

        with mock.patch.object(jev.urllib.request, "urlopen", urlopen), mock.patch.object(jev.time, "sleep", lambda s: None):
            return jev.Jev(key="k").ask({"x": 1}, {"q": {"type": "noul", "instructions": "?"}}), len(calls)

    def test_a_dropped_or_busy_request_is_asked_again(self):
        for code in (499, 429, 503):
            self.assertEqual(self.ask_with([code]), ({"q": {"noul": 0.7}}, 2), code)

    def test_a_refused_request_is_not(self):
        with self.assertRaisesRegex(jev.JevError, "HTTP 400"):
            self.ask_with([400])


if __name__ == "__main__":
    unittest.main()

"""HTTP framing is transport failure; known HTTP status remains authoritative."""
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError

from agentrun_cli.network import APIError, InvalidResponse, request
from test_cli_process import Peer


class NetworkResponses(unittest.TestCase):
    def test_incomplete_success_body_uses_the_existing_retry_exception(self):
        peer = Peer()
        self.addCleanup(peer.close)
        peer.truncated_response = ("/identity", 200)
        with self.assertRaisesRegex(InvalidResponse, "invalid_response"):
            request(peer.origin, None, "GET", "/identity")

    def test_incomplete_error_body_retains_status_and_retry_after_without_partial_payload(self):
        peer = Peer()
        self.addCleanup(peer.close)
        peer.retry_after = "17"
        for status in [401, 403, 429]:
            with self.subTest(status=status):
                peer.truncated_response = ("/identity", status)
                with self.assertRaises(APIError) as caught:
                    request(peer.origin, None, "GET", "/identity")
                self.assertEqual((caught.exception.status, caught.exception.retry_after, caught.exception.payload),
                                 (status, 17, {}))

    def test_programming_error_from_success_read_is_not_swallowed(self):
        opener = MagicMock()
        opener.open.return_value.__enter__.return_value.read.side_effect = RuntimeError("test programming error")
        with patch("agentrun_cli.network.build_opener", return_value=opener):
            with self.assertRaisesRegex(RuntimeError, "test programming error"):
                request("http://127.0.0.1", None, "GET", "/identity")

    def test_programming_error_from_error_body_is_not_swallowed(self):
        body = MagicMock()
        body.read.side_effect = RuntimeError("test programming error")
        error = HTTPError("http://127.0.0.1", 401, "Unauthorized", {"Retry-After": "17"}, body)
        opener = MagicMock()
        opener.open.side_effect = error
        with patch("agentrun_cli.network.build_opener", return_value=opener):
            with self.assertRaisesRegex(RuntimeError, "test programming error"):
                request("http://127.0.0.1", None, "GET", "/identity")


if __name__ == "__main__":
    unittest.main()

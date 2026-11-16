"""HTTP framing is transport failure; known HTTP status remains authoritative."""
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError

from agentrun_cli.network import APIError, InvalidResponse, request
from agentrun_cli.device_auth import provider_request
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


class HookErrors(unittest.TestCase):
    def test_unexpected_hook_programming_errors_remain_visible(self):
        from io import BytesIO
        from types import SimpleNamespace
        from agentrun_cli.hooks import emit
        opener = MagicMock()
        opener.open.side_effect = RuntimeError("test programming error")
        with patch("agentrun_cli.hooks.sys.stdin", SimpleNamespace(buffer=BytesIO(
                b'{"hook_event_name":"Stop","session_id":"fixture-session"}'))), \
                patch("agentrun_cli.hooks.build_opener", return_value=opener):
            with self.assertRaisesRegex(RuntimeError, "test programming error"):
                emit("http://127.0.0.1:1/v1/logs")


class DeviceResponses(unittest.TestCase):
    def test_incomplete_success_body_is_a_retryable_transport_error(self):
        peer = Peer()
        self.addCleanup(peer.close)
        peer.truncated_response = ("/identity", 200)
        with self.assertRaises(OSError):
            provider_request(peer.origin + "/identity")

    def test_incomplete_error_body_keeps_status_and_retry_after(self):
        peer = Peer()
        self.addCleanup(peer.close)
        peer.retry_after = "17"
        for status in [401, 403, 429, 503]:
            with self.subTest(status=status):
                peer.truncated_response = ("/identity", status)
                with self.assertRaises(APIError) as caught:
                    provider_request(peer.origin + "/identity")
                self.assertEqual((caught.exception.status, caught.exception.retry_after, caught.exception.payload),
                                 (status, 17, {}))

    def test_programming_error_from_success_read_remains_visible(self):
        opener = MagicMock()
        opener.open.return_value.__enter__.return_value.read.side_effect = RuntimeError("test programming error")
        with patch("agentrun_cli.device_auth.build_opener", return_value=opener):
            with self.assertRaisesRegex(RuntimeError, "test programming error"):
                provider_request("http://127.0.0.1/fixture")

    def test_programming_error_from_error_read_remains_visible(self):
        body = MagicMock()
        body.read.side_effect = RuntimeError("test programming error")
        error = HTTPError("http://127.0.0.1/fixture", 401, "Unauthorized", {}, body)
        opener = MagicMock()
        opener.open.side_effect = error
        with patch("agentrun_cli.device_auth.build_opener", return_value=opener):
            with self.assertRaisesRegex(RuntimeError, "test programming error"):
                provider_request("http://127.0.0.1/fixture")


if __name__ == "__main__":
    unittest.main()

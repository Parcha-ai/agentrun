"""The client against a server started with a priced faux model on loopback, as packages/client/test/demo.test.mjs runs
it: it creates an agent, starts a capped run and waits for it, lists runs, answers a run that asks, raises the cap of a
run stopped at it, follows a timeline and reads a file the run wrote. No error message holds the token. It skips when
the server is not built, unless AGENTRUN_PYTHON_REQUIRE_SERVER=1 (as CI sets) makes that a failure."""

from __future__ import annotations

import os
import re
import unittest
from typing import Any

from helpers import printed, serve, serve_skip_reason

from agentrun import AgentRun, AgentRunRefused, StreamedResponse, Tagged

AGENT: Any = {"definition": {"id": "notes", "version": 1, "name": "Notes", "instructions": "Do what you are asked, and write what you make to a file.", "skills": [], "tools": ["write", "ask_person"]}}
WHY = serve_skip_reason()


class Demo(unittest.TestCase):
    def setUp(self) -> None:
        if WHY is not None:
            if os.environ.get("AGENTRUN_PYTHON_REQUIRE_SERVER") == "1":
                self.fail(f"AGENTRUN_PYTHON_REQUIRE_SERVER=1, and {WHY}")
            self.skipTest(WHY)

    def test_create_an_agent_start_a_capped_run_and_wait_list_runs_answer_a_question_raise_a_cap_follow_a_timeline_read_a_file(self) -> None:
        server = serve(self)
        client = AgentRun(base_url=server.base_url, api_key=server.token)
        self.assertNotIn(server.token, printed(client), "a printed client holds no key")

        agent = client.agents.create(AGENT)
        self.assertEqual(agent["agent_id"], "notes")
        with self.assertRaises(AgentRunRefused) as caught:
            client.agents.create(AGENT)
        again = caught.exception
        self.assertEqual((again.status, again.code, (again.error or {}).get("code")), (409, "agent_exists", "agent_exists"))
        self.assertNotIn(server.token, printed(again))

        # A capped run, waited for. Capped at $5: under three held requests' worth, the server's wrap-up note comes
        # before the first request, which this faux model would read as its person's message.
        started = client.runs.start("notes", {"input": {"content": "Write notes.md with three facts about the Moon."}, "max_cost_usd": 5})
        self.assertEqual(started["agent_id"], "notes")
        done = client.runs.wait(started["run_id"], timeout=60)
        self.assertEqual((done["run_id"], done["status"], done["cost"].get("cap_usd")), (started["run_id"], "completed", 5))
        listed = client.runs.list(limit=10)
        self.assertTrue(any(run["run_id"] == started["run_id"] for run in listed["runs"]), "the run is listed")
        self.assertTrue(any(run["run_id"] == started["run_id"] for run in client.agents.runs("notes")["runs"]), "and in the agent's runs")

        # A run that asks: it waits on its person, is answered, and completes with what they said.
        asking = client.runs.start("notes", {"input": {"content": "Ask me which region to cover, then write region.md about it."}, "max_cost_usd": 5})
        asked = client.runs.wait(asking["run_id"])
        self.assertEqual((asked["status"], (asked.get("pending") or {}).get("kind")), ("input_required", "question"))
        client.runs.message(asking["run_id"], {"content": "Europe"})
        self.assertEqual(client.runs.wait(asking["run_id"])["status"], "completed")
        files = client.runs.files(asking["run_id"])
        self.assertTrue(any(file["path"] == "region.md" for file in files["files"]), files)
        region = client.runs.read_file(asking["run_id"], "region.md")
        self.assertEqual(region, b"# Europe\n")
        with client.runs.read_file(asking["run_id"], "region.md", stream=True) as streamed:
            self.assertIsInstance(streamed, StreamedResponse)
            self.assertEqual(streamed.read(), b"# Europe\n")

        # A run under a cap it cannot pay for stops at it; raised, the same run goes on and completes.
        capped = client.runs.start("notes", {"input": {"content": "Write moon.md with everything known about the Moon."}, "max_cost_usd": 0.05})
        stopped = client.runs.wait(capped["run_id"])
        pending: Any = stopped.get("pending") or {}
        self.assertEqual((stopped["status"], pending.get("kind"), stopped["cost"].get("cap_usd")), ("input_required", "budget", 0.05))
        self.assertGreater(pending["suggested_cap_usd"], 0.05)
        raise_ = client.runs.raise_cap(capped["run_id"], {"max_cost_usd": 1})
        self.assertEqual((raise_["resumed"], raise_["max_cost_usd"]), (True, 1))
        self.assertIn(raise_["status"], ("queued", "working"), f"right after the raise: {raise_}")
        raised = client.runs.wait(capped["run_id"])
        self.assertEqual((raised["run_id"], raised["status"], raised.get("pending"), raised["cost"].get("cap_usd")), (capped["run_id"], "completed", None, 1))
        self.assertRegex(client.runs.read_file(capped["run_id"], "moon.md").decode(), r"^# .+\n$", "it wrote moon.md once it went on")

        # Following a run live gives every row the timeline holds once it ended, each once.
        followed = client.runs.start("notes", {"input": {"content": "Write sun.md with three facts about the Sun."}, "max_cost_usd": 5})
        rows: dict[str, Any] = {}
        pages = []
        for page in client.runs.follow(followed["run_id"]):
            pages.append(page)
            if page["reset"]:
                rows.clear()
            for gone in page["drop"]:
                rows.pop(gone, None)
            for row in page["rows"]:
                rows[row["id"]] = row
        self.assertTrue(pages and pages[-1]["final"], "it ended with the final page")
        self.assertEqual(pages[-1]["status"], "completed")
        whole = client.runs.timeline(followed["run_id"])
        self.assertEqual(rows, {row["id"]: row for row in whole["rows"]}, "the followed rows are the timeline's")

        # A learning note read with its version, and written over with that version as If-Match.
        learner: Any = {"definition": {**AGENT["definition"], "id": "learner", "learning": True}}
        self.assertEqual(client.agents.create(learner)["agent_id"], "learner")
        note = "---\nname: policies\ndescription: Where the policies are.\n---\nLook in policies/.\n"
        client.learning.write("learner", "policies.md", note, if_none_match="*", body_type="text/markdown")
        read = client.learning.read("learner", "policies.md")
        self.assertIsInstance(read, Tagged)
        self.assertEqual(read.body, note)
        self.assertRegex(read.etag or "", r'^"[0-9a-f]+"$')
        written = client.learning.write("learner", "policies.md", note.replace("policies/", "docs/policies/"), if_match=read.etag, body_type="text/markdown")
        self.assertNotEqual(written.etag, read.etag, "the write answers the note's new version")
        self.assertTrue(re.match(r'^"[0-9a-f]+"$', written.etag or ""))


if __name__ == "__main__":
    unittest.main()

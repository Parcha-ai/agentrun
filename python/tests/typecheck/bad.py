"""Calls the client's types refuse: pyright must fail on each line marked `# error`, and on no other."""

from __future__ import annotations

from agentrun import AgentRun


def consumer() -> None:
    client = AgentRun()
    client.agents.create({"definitio": {"version": 1, "name": "a", "instructions": "a", "skills": [], "tools": []}})  # error
    client.runs.start("notes", {"input": {}, "max_cost_usd": "1"})  # error
    client.runs.message("r1", {})  # error
    client.runs.get("r1", limit=1)  # error
    text: str = client.runs.read_file("r1", "a.md")  # error
    client.runs.nope("r1")  # error
    client.mcp_servers.oauth_start("docs")  # error
    print(text)

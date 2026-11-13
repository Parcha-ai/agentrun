"""A consumer of the client as its README shows it: pyright must pass this file, in strict mode."""

from __future__ import annotations

from agentrun import AgentRun, AgentRunRefused, AgentRunTimeout, Run, StreamedResponse, Tagged, TimelinePage


def consumer() -> None:
    client = AgentRun(base_url="https://agentrun.example.com/v2", api_key="key")
    agent = client.agents.create({"definition": {"id": "notes", "version": 1, "name": "Notes", "instructions": "Write notes.", "skills": [], "tools": ["write"]}})
    agent_id: str = agent["agent_id"]
    started = client.runs.start(agent_id, {"input": {"content": "Write notes.md."}, "max_cost_usd": 0.5}, idempotency_key="start-1")
    run: Run = client.runs.wait(started["run_id"], timeout=60)
    pending = run.get("pending")
    if run["status"] == "input_required" and pending is not None and pending["kind"] == "question":
        client.runs.message(run["run_id"], {"content": "Europe"})
    if pending is not None and pending["kind"] == "budget":
        client.runs.raise_cap(run["run_id"], {"max_cost_usd": 1})
    listed = client.runs.list(limit=10, status="completed")
    first: str | None = listed["runs"][0]["run_id"] if listed["runs"] else None
    for page in client.runs.follow(run["run_id"]):
        timeline: TimelinePage = page
        print(len(timeline["rows"]))
    data: bytes = client.runs.read_file(run["run_id"], "notes.md")
    with client.runs.read_file(run["run_id"], "notes.md", stream=True) as response:
        streamed: StreamedResponse = response
        print(streamed.read(10))
    note: Tagged[str] = client.learning.write("notes", "policies.md", "# Policies\n", if_none_match="*", body_type="text/markdown")
    client.files.upload("f1", b"\x89PNG", body_type="image/png")
    try:
        client.agents.get("notes")
    except AgentRunRefused as error:
        print(error.status, error.code, (error.error or {}).get("message"))
    except AgentRunTimeout as error:
        print(error.run["status"] if error.run else None)
    print(first, data, note.etag)

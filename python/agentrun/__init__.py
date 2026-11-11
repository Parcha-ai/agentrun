"""parcha-agentrun: a typed Python client for a self-hosted AgentRun server. One method per operation of its v2 API,
typed from the OpenAPI document it serves, plus waiting for a run and following its timeline. Standard library only.

    from agentrun import AgentRun

    client = AgentRun(base_url="https://agentrun.example.com/v2", api_key=os.environ["AGENTRUN_API_KEY"])
    run = client.runs.wait(client.runs.start("notes", {"input": {"content": "Write notes.md."}})["run_id"])
"""

from ._client import AgentRun, Runs
from ._errors import (
    AgentRunAuthError,
    AgentRunError,
    AgentRunRefused,
    AgentRunTimeout,
    AgentRunUnreachable,
    AgentRunUnsupported,
    AgentRunUsage,
    ServerError,
)
from ._generated import *  # noqa: F403 - every generated type, group and the operation table, by its __all__
from . import _generated
from ._http import StreamedResponse
from ._types import AnswerKind, Operation, OperationBody, RawBody, Tagged

__version__ = "0.3.1"

__all__ = [
    "AgentRun",
    "AgentRunAuthError",
    "AgentRunError",
    "AgentRunRefused",
    "AgentRunTimeout",
    "AgentRunUnreachable",
    "AgentRunUnsupported",
    "AgentRunUsage",
    "AnswerKind",
    "Operation",
    "OperationBody",
    "RawBody",
    "Runs",
    "ServerError",
    "StreamedResponse",
    "Tagged",
]
__all__ += _generated.__all__

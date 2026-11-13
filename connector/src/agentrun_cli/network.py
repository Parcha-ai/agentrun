"""Origin-bound HTTP and private enrollment credentials."""

import json
import os
import stat
from typing import Annotated, Literal
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from pydantic import BaseModel, ConfigDict, Field

Identifier = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")]
MAX_SELECTIONS = 1000


class Envelope(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)


class Selection(Envelope):
    source_id: Identifier
    harness: Literal["claude", "codex"]
    mode: Literal["session", "project", "harness"]
    external_session_id: Identifier | None
    include_future_sessions: bool


class Identity(Envelope):
    workspace_ids: list[Annotated[str, Field(min_length=1, max_length=256)]]


class Capabilities(Envelope):
    version: Literal[1]
    ingestion_modes: list[str]
    supported_harnesses: list[str]
    logs_formats: list[str]
    logs_endpoint_template: str
    selections_revision_header: str
    max_log_records: int = Field(ge=100)
    max_payload_bytes: int = Field(ge=65536)
    privacy: dict
    token_usage: dict | None = None


class Connector(Envelope):
    id: Identifier
    workspace_id: str
    selections_revision: int = Field(ge=1)
    selections: list[Selection] = Field(max_length=MAX_SELECTIONS)


class Registration(Envelope):
    connector: Connector
    credential: str = Field(min_length=1, max_length=8192, pattern=r"^[^\r\n]+$")
    credential_expires_at: str


class Heartbeat(Envelope):
    connector_id: Identifier
    selections_revision: int = Field(ge=1)
    selections: list[Selection] = Field(max_length=MAX_SELECTIONS)
    heartbeat_interval_seconds: int = Field(ge=1, le=3600)


class Acknowledgement(Envelope):
    accepted_event_ids: list[Identifier] = Field(max_length=100)


class InvalidResponse(OSError):
    """A transport response cannot safely change durable local state."""


def response_payload(data, method, route):
    path = urlsplit(route).path
    model = (Capabilities if path == "/connectors/capabilities" else Identity if path == "/identity" else
             Registration if method == "POST" and (path == "/connectors" or path.endswith("/rotate-credential")) else
             Heartbeat if path.endswith("/heartbeat") else
             Acknowledgement if path.endswith("/events") else Connector)
    try:
        return model.model_validate_json(data).model_dump()
    except ValueError:
        raise InvalidResponse("invalid_response") from None


class APIError(Exception):
    def __init__(self, status, payload, retry_after=None):
        self.status = status
        self.payload = payload
        self.retry_after = retry_after
        super().__init__("api_error")


def origin(value):
    parsed = urlsplit(value or "")
    if (parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {"", "/"}
            or not parsed.hostname or (parsed.scheme != "https" and not
                                      (parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}))):
        raise ValueError("invalid_origin")
    return f"{parsed.scheme}://{parsed.netloc}".rstrip("/")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(api_origin, credential, method, route, body=None):
    base = origin(api_origin)
    raw = None if body is None else json.dumps(body, separators=(",", ":")).encode()
    headers = {"Content-Type": "application/json"}
    if credential is not None:
        headers["Authorization"] = "Bearer " + credential
    req = Request(base + "/api/v2/control" + route, data=raw, method=method, headers=headers)
    try:
        with build_opener(NoRedirect).open(req, timeout=10) as response:
            data = response.read(1_000_001)
            if len(data) > 1_000_000:
                raise InvalidResponse("response_limit")
            return response_payload(data, method, route)
    except HTTPError as error:
        try:
            payload = json.loads(error.read(65536))
        except ValueError:
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        try:
            retry_after = max(0, min(300, int(error.headers.get("Retry-After", ""))))
        except ValueError:
            retry_after = None
        raise APIError(error.code, payload, retry_after) from None


def read_credential(file, api_origin):
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as handle:
        info = os.fstat(handle.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 65536):
            raise ValueError("unsafe_credential")
        saved = json.load(handle)
    if not isinstance(saved, dict):
        raise ValueError("invalid_credential")
    if origin(saved.get("origin")) != api_origin:
        raise ValueError("credential_origin_mismatch")
    token = saved.get("api_key")
    if not isinstance(token, str) or not token or len(token) > 8192 or "\n" in token or "\r" in token:
        raise ValueError("invalid_credential")
    return token

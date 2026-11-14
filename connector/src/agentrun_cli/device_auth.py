"""Device authorization with an in-memory enrollment credential."""

import json
import time
from http.client import HTTPException
from typing import Annotated
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, build_opener

from pydantic import Field, field_validator

from . import __version__
from .network import APIError, Envelope, NoRedirect


Visible = Annotated[str, Field(min_length=1, max_length=2048, pattern=r"^[\x21-\x7e]+$")]


class Metadata(Envelope):
    issuer: Visible
    client_id: Visible
    device_authorization_endpoint: Visible
    token_endpoint: Visible
    scope: str = Field(min_length=1, max_length=1024, pattern=r"^[\x20-\x7e]+$")
    resource: Visible
    verification_uri: Visible | None = None


class DeviceGrant(Envelope):
    device_code: str = Field(min_length=1, max_length=8192, pattern=r"^[\x21-\x7e]+$")
    user_code: str = Field(min_length=1, max_length=256, pattern=r"^[\x20-\x7e]+$")
    verification_uri: Visible
    verification_uri_complete: Visible | None = None
    expires_in: int = Field(ge=1, le=3600)
    interval: int = Field(default=5, ge=1, le=300)


class AccessToken(Envelope):
    access_token: str = Field(min_length=1, max_length=8192, pattern=r"^[\x21-\x7e]+$")
    token_type: str
    expires_in: int | None = Field(default=None, ge=1)

    @field_validator("expires_in", mode="before")
    @classmethod
    def present_expiry(cls, value):
        if value is None:
            raise ValueError("device_invalid_response")
        return value


def validated(model, value):
    try:
        return model.model_validate(value).model_dump()
    except ValueError:
        raise ValueError("device_invalid_response") from None


def checked_url(value, api_origin, allow_query=False):
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        raise ValueError("device_invalid_response") from None
    loopback = {"localhost", "127.0.0.1", "::1"}
    if (not parsed.hostname or port == 0 or parsed.username is not None or parsed.password is not None or parsed.fragment
            or (parsed.query and not allow_query) or "\\" in value
            or any(ord(char) <= 32 or ord(char) == 127 for char in value)
            or (parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in loopback
                                                  and urlsplit(api_origin).hostname in loopback))):
        raise ValueError("device_invalid_response")
    return parsed.scheme, parsed.hostname, port or (443 if parsed.scheme == "https" else 80)


def provider_request(url, body=None, timeout=10):
    request = Request(url, data=None if body is None else urlencode(body).encode(),
                      headers={"Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded",
                               "User-Agent": "agentrun-cli/" + __version__})
    try:
        with build_opener(NoRedirect).open(request, timeout=timeout) as response:
            data = response.read(65537)
            if len(data) > 65536:
                raise ValueError("device_invalid_response")
            try:
                payload = json.loads(data)
            except ValueError:
                raise ValueError("device_invalid_response") from None
            if isinstance(payload, dict) and payload.get("error"):
                raise APIError(400, payload)
            return payload
    except HTTPError as error:
        try:
            payload = json.loads(error.read(65536))
        except (ValueError, HTTPException):
            payload = {}
        try:
            retry_after = max(0, min(300, int(error.headers.get("Retry-After", ""))))
        except ValueError:
            retry_after = None
        raise APIError(error.code, payload if isinstance(payload, dict) else {}, retry_after) from None
    except OSError:
        raise
    except HTTPException:
        raise ValueError("device_invalid_response") from None


def authorization_error(error):
    code = error.payload.get("error")
    if code == "access_denied":
        raise ValueError("device_authorization_denied") from None
    if code == "expired_token":
        raise ValueError("device_authorization_expired") from None
    if isinstance(code, str) and code in {"unauthorized_client", "invalid_client", "unsupported_grant_type"}:
        raise ValueError("device_authorization_unavailable") from None
    raise error


def authenticate(api_origin):
    try:
        return authorize(api_origin)
    except KeyboardInterrupt:
        raise ValueError("device_authorization_cancelled") from None


def authorize(api_origin):
    try:
        metadata = validated(Metadata, provider_request(api_origin + "/api/v2/control/auth/device"))
        if set(metadata["scope"].split()) != {"research:read", "research:write"}:
            raise ValueError("device_invalid_response")
        issuer = checked_url(metadata["issuer"], api_origin)
        if any(checked_url(metadata[key], api_origin) != issuer for key in ["device_authorization_endpoint", "token_endpoint"]):
            raise ValueError("device_invalid_response")
        if metadata["verification_uri"] is not None:
            checked_url(metadata["verification_uri"], api_origin)
    except ValueError:
        raise ValueError("device_invalid_response") from None
    except APIError as error:
        if error.status in {404, 503}:
            raise ValueError("device_authorization_unavailable") from None
        raise
    requested_at = time.monotonic()
    try:
        device = validated(DeviceGrant, provider_request(metadata["device_authorization_endpoint"], {
            "client_id": metadata["client_id"], "scope": metadata["scope"], "audience": metadata["resource"],
        }))
    except APIError as error:
        authorization_error(error)
    checked_url(device["verification_uri"], api_origin, allow_query=True)
    if device["verification_uri_complete"] is not None:
        checked_url(device["verification_uri_complete"], api_origin, allow_query=True)
    print(json.dumps({"status": "device_authorization_pending", "verification_uri": metadata["verification_uri"] or device["verification_uri"],
                      "user_code": device["user_code"]}), flush=True)
    interval = device.get("interval", 5)
    delay = interval
    deadline = requested_at + device["expires_in"]
    while time.monotonic() < deadline:
        time.sleep(min(delay, max(0, deadline - time.monotonic())))
        if time.monotonic() >= deadline:
            break
        try:
            token = validated(AccessToken, provider_request(metadata["token_endpoint"], {
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code", "device_code": device["device_code"],
                "client_id": metadata["client_id"], "audience": metadata["resource"],
            }, timeout=max(0.001, min(10, deadline - time.monotonic()))))
            if time.monotonic() >= deadline:
                break
            if token["token_type"].lower() != "bearer":
                raise ValueError("device_invalid_response")
            return token["access_token"]
        except APIError as error:
            if error.status == 400 and error.payload.get("error") == "authorization_pending":
                delay = interval
                continue
            if error.status == 400 and error.payload.get("error") == "slow_down":
                interval += 5
                delay = interval
                continue
            if error.status == 429 or error.status >= 500:
                delay = max(interval, min(60, delay * 2), error.retry_after or 0)
                continue
            authorization_error(error)
        except OSError:
            delay = max(interval, min(60, delay * 2))
    raise ValueError("device_authorization_expired")

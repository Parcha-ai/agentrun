---
packages: @parcha/agentrun-computer
kind: fix
---
The phone harness provider's API calls go through the shared REST client, so a redirect from the API fails in that client's words, "POST /sessions: the API answered with a redirect, which is never followed: it would carry the key", where it said the phone harness could not be reached. A create that meets a redirect is now a refusal: it no longer asks the service for a phone by the request's key as if the answer had been lost. A request cut off by its bound now reads "GET /sessions/<id> did not answer within 30 s", one that gets no answer keeps the code `unreachable` in the client's words, and a `phones_busy` refusal's wait comes from the answer's `retry_after_seconds`.

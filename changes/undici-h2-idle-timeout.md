---
packages: @parcha/agentrun-serve
kind: fix
---
serve no longer ends when an idle HTTP/2 connection to Archil or E2B times out. A request aborted on an open HTTP/2 connection left a stream behind, and when the connection then sat idle its close threw `InformationalError: socket idle timeout` with nothing to catch it, which ended the whole process and every run in it. undici is now 8.14.0, which resets an aborted stream at once, for serve and for the Archil and E2B SDKs it loads.

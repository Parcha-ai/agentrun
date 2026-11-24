---
packages: @parcha/agentrun-computer
kind: breaking
---
Five providers refuse an `http://` API URL, a loopback host's included, so the key never crosses in the clear: Groundbox's `apiUrl` since beta.55, and from this release boxd's `baseUrl`, Modal's `serverUrl`, smol cloud's `apiUrl` and the phone harness's `baseUrl`. The provider throws when it is made, before any call, in the words of the shared rule: "the Groundbox API URL must be https, so the key never crosses in the clear: http:", and the same with "the boxd API URL", "the Modal server URL (options.serverUrl)", "the smol cloud API URL" or "the phone harness URL". beta.55 listed the Groundbox change as a fix, and the others went in as fixes too; each one breaks a caller that relied on http. Who breaks: a caller that points one of these providers at an http URL, such as a local fake or a proxy on the same machine. What to do: serve that URL over https and pass the `https://` URL.

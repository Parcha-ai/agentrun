---
packages: @parcha/agentrun-serve
kind: feature
---
On Linux, a Docker box reaches a list of hosts, and nothing else: by default `pypi.org`, `files.pythonhosted.org`, `registry.npmjs.org`, `registry.yarnpkg.com`, `github.com` and `codeload.github.com`, so `pip install` and `npm install` work in it. `AGENTRUN_BOX_ALLOW` replaces the list with a comma list of names (where `*.example.com` names the hosts below `example.com`); `AGENTRUN_BOX_ALLOW=none` is the box offline, as before.
- The box stays `--network none`. The run's process starts the kernel's egress proxy with the list, on a Unix socket in a directory of its own under `/tmp/agentrun-egress-<uid>/`, bound into the box read-only at `/run/agentrun/egress/`. A `socat` in the box relays `127.0.0.1:3128` to it, and `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`, `https_proxy`, `NO_PROXY` and `no_proxy` name it in the box's fixed environment. A program that skips them has no route out.
- A host off the list, an IP address and any port but 80 and 443 are refused before any lookup: `403 <host> is not on this box's network list: use web_fetch for web pages, or ask the operator to add it to AGENTRUN_BOX_ALLOW`. A listed name whose address is private, this machine's or a cloud's metadata is refused too. The proxy holds no key and adds none.
- The server decides once, at start, and fails closed: the box has the list only when this machine is Linux, the docker CLI's endpoint is a local unix socket, and `docker info` answers within 5 s with Linux containers on this machine's own kernel. Anything else (a Docker in a VM such as Docker Desktop or OrbStack, a daemon elsewhere, docker info that fails or does not answer) leaves the box with no network, and says why, naming what it found.
- Capabilities give the list as `places.allow`, and each box's `network`: `allowlist` or `none`, with `network_reason` when an available box has none. The start's banner says the same.
- `*`, an IP address, a CIDR or a URL in the setting refuses the start, naming it.
- The default box image adds `npm` and `socat`, so it builds once more. An image with no `socat` gets no network, and the run's timeline says so once.

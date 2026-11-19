---
packages: @parcha/agentrun
kind: fix
---
`install.sh --vps` pulls its image on every run, so `--image` with a tag that moves (`:beta`) runs the registry's image now, not the one an earlier run left on the server; a tag already current pulls nothing, and an image no registry has (built on the server) runs as it is. The README also says that an older version installed over a newer one does not start on the store the newer one upgraded: its server says so and exits, and the store is left as it was.

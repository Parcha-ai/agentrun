# AgentRun Server on Kubernetes

One AgentRun server and its runner in one pod, on a 10 GiB volume, from the release's published image. Needs no model
key.

```sh
helm install agentrun oci://ghcr.io/parcha-ai/charts/agentrun --devel --namespace agentrun --create-namespace
```

Each release publishes the chart at its own version, installing that release's image. Releases are betas for now,
and Helm skips a prerelease unless told: `--devel` takes the newest, `--version 0.1.0-beta.66` a given one. From a
checkout, `helm install agentrun deploy/helm/agentrun` installs this one.

Then open the console. The install's notes print the two commands: a port-forward, and the one that reads your token
from the Secret. Set your password with the token on the first screen. Then Continue with ChatGPT, or add a model key
(Settings, Model keys), and run your first agent.

## What it makes

- **A Deployment** with one replica and the Recreate strategy. The store is SQLite on `/data`, so a new server starts
  only after the old one stops. Requests are 500m CPU and 2Gi memory, with a 2Gi memory limit: the runner budgets runs
  by that limit.
- **A Secret** holding `AGENTRUN_TOKEN` and `AGENTRUN_SEAL_KEY`, made at install and kept on every upgrade. They are
  never values. The model keys, MCP credentials and trigger secrets you save are sealed under the seal key, so losing
  the key loses them. An upgrade that can't read the Secret stops rather than make new keys.
- **A PersistentVolumeClaim** for `/data`, 10Gi on the default StorageClass. An init container sets the volume's root
  to the server's user and mode 0711, as the image has it: each run's process crosses it to its own folders without
  listing it.
- **A Service** on port 7340, and an **Ingress** when `ingress.enabled` is true. The ingress's address is the server's
  `AGENTRUN_PUBLIC_URL` unless `env.AGENTRUN_PUBLIC_URL` sets another.

`helm uninstall` removes the Deployment, the Service and the Ingress, and **keeps the Secret and the volume**
(`helm.sh/resource-policy: keep`): every run, and the seal key everything sealed is read with, survive it. An install
with the same release name in the same namespace takes them up again, the same token included. To remove them too,
after `helm uninstall`:

```sh
kubectl -n agentrun delete secret agentrun
kubectl -n agentrun delete pvc agentrun
```

A Secret or a claim of your own (`existingSecret`, `persistence.existingClaim`) is never made or removed by the chart.

Every value is in [values.yaml](values.yaml), with what it does (`helm show values deploy/helm/agentrun`). Model keys go
in the console, never in values.

## Argo CD, Flux and `helm template`

These render the chart without reading the cluster, so the chart can't see the keys it made before, and would make new
ones at every render. Make the Secret yourself and set `existingSecret`:

```sh
kubectl -n agentrun create secret generic agentrun-keys \
  --from-literal=AGENTRUN_TOKEN="$(openssl rand -hex 32)" \
  --from-literal=AGENTRUN_SEAL_KEY="$(openssl rand -base64 32)"
```

## What agents get

File tools and `web_fetch`, and no shell: a cluster gives the server no Docker. For a shell, add a sandbox provider's
key in the console.

Each run's process runs as a user of its own. The run helper switches to it, and gives the run's folders to it and back,
with four file capabilities (`CHOWN`, `SETUID`, `SETGID`, `SETPCAP`), which the container keeps while dropping every
other capability (the kernel refuses to start the helper when one is missing), and the init container runs as
root with `CHOWN` and `FOWNER`. The pod therefore needs the `baseline` Pod Security level (Kubernetes' default): a
namespace that enforces `restricted` rejects it, and the chart doesn't support one.

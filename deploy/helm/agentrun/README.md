# AgentRun Server on Kubernetes

One AgentRun server and its runner in one pod, on a 10 GiB volume, from the release's published image. Needs no model
key.

```sh
git clone --depth 1 https://github.com/Parcha-ai/agentrun && cd agentrun
helm install agentrun deploy/helm/agentrun --namespace agentrun --create-namespace
```

Then open the console. The install's notes print the two commands: a port-forward, and the one that reads your token
from the Secret. Set your password with the token on the first screen. Then Continue with ChatGPT, or add a model key
(Settings, Model keys), and run your first agent.

## What it makes

- **A Deployment** with one replica and the Recreate strategy. The store is SQLite on `/data`, so a new server starts
  only after the old one stops. Requests are 500m CPU and 2Gi memory, with a 2Gi memory limit: the runner budgets runs
  by that limit, less 128 MiB (six Claude Agent runs or fifteen pi runs at once; the rest wait queued).
- **A Secret** holding `AGENTRUN_TOKEN` and `AGENTRUN_SEAL_KEY`, made at install and kept on every upgrade. They are
  never values. The model keys, MCP credentials and trigger secrets you save are sealed under the seal key, so losing
  the key loses them. An upgrade that can't read the Secret stops rather than make new keys.
- **A PersistentVolumeClaim** for `/data`, 10Gi on the default StorageClass. An init container sets the volume's root
  to the server's user and mode 0711, as the image has it: each run's process crosses it to its own folders without
  listing it.
- **A Service** on port 7340, and an **Ingress** when `ingress.enabled` is true.

`helm uninstall` removes the Deployment, the Service and the Ingress, and **keeps the Secret and the volume**
(`helm.sh/resource-policy: keep`): every run, and the seal key everything sealed is read with, survive it. An install
with the same release name in the same namespace takes them up again, the same token included. To remove them too,
after `helm uninstall`:

```sh
kubectl -n agentrun delete secret agentrun
kubectl -n agentrun delete pvc agentrun
```

With `keepOnUninstall: false`, `helm uninstall` removes them with the release. A Secret or a claim of your own
(`existingSecret`, `persistence.existingClaim`) is never made or removed by the chart.

## Values

| Value | Default | What it does |
| --- | --- | --- |
| `publicUrl` | empty | `AGENTRUN_PUBLIC_URL`: the address people open the console at. The links the server prints and sends use it. |
| `ingress.enabled`, `.host`, `.className`, `.tlsSecret`, `.annotations` | off | An Ingress for `host`, with TLS from `tlsSecret` when set. |
| `existingSecret` | empty | A Secret of yours with `AGENTRUN_TOKEN` (32 characters or more) and `AGENTRUN_SEAL_KEY` (`openssl rand -base64 32`). Each of its keys becomes a variable. |
| `persistence.size`, `.storageClass`, `.existingClaim` | 10Gi, default, empty | The volume for `/data`. |
| `keepOnUninstall` | `true` | `helm uninstall` leaves the Secret and the volume the chart made. `false` removes them with the release. |
| `env` | `{}` | Plain variables by name, such as `AGENTRUN_TELEMETRY: "0"` to turn the usage counts off ([docs/telemetry.md](../../../docs/telemetry.md)). |
| `resources` | 500m and 2Gi, 2Gi limit | The pod's resources. |
| `terminationGracePeriodSeconds` | 35 | A stopping pod's time before it is killed: the 6 s drain plus the runner's 25 s. Raise it with a longer `--drain-timeout`. |
| `image.repository`, `.tag`, `.pullPolicy` | the release's image | `tag` empty means `v<appVersion>`. |
| `args`, `extraVolumes`, `extraVolumeMounts` | empty | The container's arguments (empty: the image's own), and volumes to add. |

Model keys go in the console, never in values.

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

Each run's process runs as a user of its own. The run helper switches to it with three file capabilities (`SETUID`,
`SETGID`, `SETPCAP`), which the container keeps while dropping every other capability, and the init container runs as
root with `CHOWN` and `FOWNER`. The pod therefore needs the `baseline` Pod Security level (Kubernetes' default): a
namespace that enforces `restricted` rejects it, and the chart doesn't support one.

## The walk

`deploy/helm/walk.sh`, which CI runs on kind (`.github/workflows/helm-walk.yml`), takes about 3 minutes, most of it
the image pull. It installs the chart with its own image on a faux model (no key, no network, the counts off) and
waits until it's ready. It checks the keys, the data directory, each run's own user and the runner's memory, then
runs a first run to completed. Then it upgrades onto a new pod and checks that the keys and the run were kept. It
uninstalls and checks that the Secret and the volume were kept, then installs again under the same name and checks that
the first run is still listed with the same token. Last, it uninstalls, deletes the kept Secret and volume, and checks
that nothing is left.

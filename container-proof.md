# Standalone container proof

**PASS — 8/8 checks on public commit `d9ff826d`.** The repository's unchanged `packages/serve/docker/Dockerfile` built a new image from a fresh `git archive` of the final public commit `d9ff826df3195a2fb94530ad95d39186168341c8`. Public build-layer cache was allowed; the workspace/console dependency installation and compilation reran. An empty, isolated Docker configuration supplied no registry credentials. The build used public npm packages and the Dockerfile's pinned public Node/Debian base. No installed host dependencies, Grep checkout, private package credentials, model credentials or private services entered the build context.

Prior commits `0d1fb055`, `3573f4a6`, `01970d29` and `12fc3414` also passed separate builds and eight runtime checks; those receipts are retained separately and are not the final-head proof below. The current proof includes the final native summary fields and the main-branch Stop/webhook test corrections.

The image started as `node` with fresh data, published only at **`127.0.0.1:32832`**, and executed a real child-process run using the native faux-model module. No paid model call, deployment, public route or registry push occurred.

- Local tag retained: `gre4118-console-proof:d9ff826d-ccee69d4`
- Image ID: `sha256:41cee42115ea7ea972ebb9d6bbc9e368dfa6b28e6b6e9808075c9045b3ac8cd0`
- Image size reported by Docker: `388818745` bytes
- Docker engine: `29.6.1`

| Check | Result | Observed evidence |
|---|---|---|
| Isolation | PASS | One published binding: `127.0.0.1:32832 → 7340/tcp`; runtime user `node`; unique named data volume. |
| Health | PASS | `GET /v2/health → 200`, `status: ok`, store/disk both `ok`. |
| Unauthorized data | PASS | Missing and incorrect bearer credentials each returned `401 unauthenticated`. |
| Native capabilities | PASS | `agentrun.v2/0`, server `0.1.0-beta.28`, `pi` available with faux mode; no Claude/Codex model credentials supplied. |
| Bundled console | PASS | `/`, its exact JS and CSS assets each returned `200`; an unlisted asset returned `404`; strict CSP retained. |
| Owner/session boundary | PASS | Setup `201`, signed-in cookie `HttpOnly; SameSite=Strict`; cookie read `200`; protected cookie write from another origin `401`. |
| Actual run | PASS | Agent create `201`; pinned run start `202`; timeline reached `completed`, `final: true`; persisted answer **“The answer is 42.”** Timeline rows: user message, thinking, final answer, usage. Both global and per-agent run summaries reported `result_available:true,files_available:false` after completion, then `result_available:true,files_available:true` after adding files. WAV/WebM files exposed the expected native metadata and response MIME, unchanged bytes and `nosniff`. |
| Native image gate | PASS | No Claude Agent SDK/CLI; bundled Codex `0.164.0` passed the repository's pinned-build verification. |

The container served the **same final console bytes** as the independently witnessed 31-checkpoint browser QA:

- `assets/index-Bpz8EcuG.js`: SHA-256 `fda64627b643b165d22bac8f9b48c739ae6b00f821b2d3fdf9f867b13e073f0c`
- `assets/index-MZWl1iOl.css`: SHA-256 `bf50c1d29c09f394dbd98026fef8f8c8cae60514718ac97b42d0ea5b6daf512f`

Source build hash: `a4d0d7727c39e1d016ecc14f513e516118949f96ce3c613a899b21e8854e3c97`.

The run ID was `01a19f4b-8e91-755e-9185-5a536c1d39f0`, on revision `bd1e004e5ba9f1ff00143fe063b5121d8db825dbafd27c0d6b212e90acff9910` of synthetic agent `container-proof`.

## Receipts and reproduction

[Structured results and cleanup readback](gre4118-container-proof-evidence/runtime-result.json), [sanitized native server log](gre4118-container-proof-evidence/runtime.sanitized.log), [full public build log](gre4118-container-proof-evidence/build.log), and the [Node-builtins runtime verifier](gre4118-container-proof-evidence/runtime-proof.mjs) show the assertions and their observed responses. The verifier reads the generated local token only in memory; credential values and session cookies are absent from these receipts.

From a public checkout at the tested commit, with the verifier beside this report:

```sh
proof_dir=$(mktemp -d)
mkdir "$proof_dir/context" "$proof_dir/docker-config"
printf '{"auths":{}}\n' > "$proof_dir/docker-config/config.json"
git archive --format=tar d9ff826d | tar -x -C "$proof_dir/context"

node --input-type=module - "$proof_dir" <<'JS'
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const root = process.argv[2], suffix = randomUUID().slice(0, 8);
writeFileSync(`${root}/metadata.json`, JSON.stringify({
  root, docker_config: `${root}/docker-config`, commit: 'd9ff826df3195a2fb94530ad95d39186168341c8',
  expectedJsSha256: 'fda64627b643b165d22bac8f9b48c739ae6b00f821b2d3fdf9f867b13e073f0c',
  expectedCssSha256: 'bf50c1d29c09f394dbd98026fef8f8c8cae60514718ac97b42d0ea5b6daf512f',
  tag: `gre4118-console-proof:d9ff826d-${suffix}`,
  container: `gre4118-console-proof-${suffix}`,
  volume: `gre4118-console-proof-${suffix}-data`
}));
JS

tag=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).tag' "$proof_dir/metadata.json")
env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
  DOCKER_CONFIG="$proof_dir/docker-config" docker build --progress=plain \
  --file "$proof_dir/context/packages/serve/docker/Dockerfile" \
  --tag "$tag" "$proof_dir/context"
node gre4118-container-proof-evidence/runtime-proof.mjs "$proof_dir/metadata.json"
```

The verifier starts the native entrypoint with `--data /data --listen 0.0.0.0 --port 7340 --drain-timeout 2s --faux /opt/agentrun/packages/serve/test/fixtures/faux-model.mjs`; Docker publishes only `127.0.0.1::7340` to an allocated loopback port. It stops/removes only its exact generated container and removes only its exact generated data volume in `finally`.

## Cleanup and limits

The test container `gre4118-console-proof-ccee69d4` stopped and was removed. Its data volume `gre4118-console-proof-ccee69d4-data` was removed. Readback confirms both are absent and the local image remains. The final-head verifier passed on its first runtime attempt. Its exact JavaScript and CSS digest assertions bind the container to the final reviewed console artifacts. Summary availability was checked independently on both native list routes before and after adding media files. No product change was needed.

This proves one local Linux image build/start, console serving, auth boundary and native faux run. It does not qualify paid providers, other architectures, cloud deployment or production migration. The public dependency install emitted existing audit warnings: the workspace install reported **7 moderate** vulnerabilities; the console install reported **14** (**7 moderate, 3 high, 4 critical**). This receipt records those warnings and makes no claim that dependency vulnerabilities were remediated. No source file or dependency lock was changed for this proof.

File availability limits metadata inspection to 128 work entries and directory depth to 16. The native walker still enumerates directory names without a hard enumeration budget; the docs and generated contract state this limitation. This proof establishes availability results, not a fixed CPU/memory bound for very wide directories.

---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
Turning Archil on no longer asks for the region's S3 URL when serve knows the region. For `aws-us-east-1`, `aws-us-west-2`, `aws-eu-west-1` and `gcp-us-central1` (the regions Archil's SDK names a control plane for), `PUT /v2/workspace/archil` takes the region alone and saves that region's S3 endpoint (the control plane's host with `control.` made `s3.`, such as `https://s3.green.us-east-1.aws.prod.archil.com`); an `s3Url` given is still checked as https and used instead. The same holds where the server is started: `AGENTRUN_ARCHIL_REGION` alone is enough for a known region, and `AGENTRUN_ARCHIL_S3_URL` is needed only for another one.
- A region serve doesn't know, with no `s3Url`, is `422 input_invalid` at `s3Url` saying the region needs one and naming the regions serve knows; a server started that way stops in the same words. An `s3Url` that is not https, or empty, for a known region is refused naming that region's URL.
- `GET /v2/workspace/archil` (`x-agentrun-serve: "archil/2"`) adds `regions`, each region serve knows with its S3 URL, and, while on, `s3UrlFrom`: `region` when `s3Url` is the region's own, `given` otherwise.
- Settings → Workspace offers the known regions in the Region field, and leaves S3 URL empty for one of them, showing the region's URL as its placeholder.
- A disk-free runner reads a server started with `AGENTRUN_ARCHIL_REGION` alone as in Archil mode.
- A runner given `AGENTRUN_ARCHIL_REGION` without `AGENTRUN_ARCHIL_S3_URL` claims nothing while the server's S3 URL may be another (the server is started with `AGENTRUN_ARCHIL_S3_URL`, or its saved settings hold an `s3Url` other than the region's), and says on its presence row to hand it the server's S3 URL, so a runner and its server never reach a run's folder at two endpoints. `runner --check` lists `AGENTRUN_ARCHIL_S3_URL` as missing on such a runner when the server is started with it.

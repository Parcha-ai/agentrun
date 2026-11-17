#!/bin/sh
# AgentRun's Railway template, published from deploy/railway/template.json and walked. Needs node 24 and, for a run
# against Railway, a workspace token as RAILWAY_API_TOKEN: in the environment, or as a RAILWAY_API_TOKEN=... line on
# stdin with --secrets-stdin. Never put it on the command line.
#
#   deploy/railway/publish-and-walk.sh WORKSPACE_ID --expect-workspace NAME
#       Stops before making anything unless the workspace is named NAME. Then it makes or updates the template from
#       template.json, through the source project agentrun-template-source, which never deploys. It deploys the template
#       once into a throwaway project, waits for /v2/health, and checks that the first visit asks for the setup code and
#       that AGENTRUN_TOKEN works as that code. It reads the project's Railway usage, deletes the project, and publishes
#       the template. It prints the README's button line when that line changes. Each run costs a few cents of usage.
#   ... --first-run [--model ID]
#       Also the first run a person makes: OPENROUTER_API_KEY (from the environment or stdin, as the token is) goes in
#       the deploy's form, then a no-tool "Release notes" agent on pi runs to completion over the API with the deploy's
#       AGENTRUN_TOKEN. The run is capped at $1.
#   ... publish-and-walk.sh WORKSPACE_ID --walk CODE       walks the template CODE and publishes nothing (a release's check)
#   ... publish-and-walk.sh WORKSPACE_ID --template CODE   walks and publishes CODE, a template made in Railway's editor
#   deploy/railway/publish-and-walk.sh --dry-run [WORKSPACE_ID]
#       No token, no network: the plan of a first run, every call in order with its variables, against a stand-in.
#   deploy/railway/publish-and-walk.sh --check-api
#       No token: Railway's live GraphQL API validates every operation the script sends.
#
# Each run prints its report on stdout, a Verdict line and then a table of step, result and evidence. With REPORT=<file>
# it also goes in that file, and TIMES=<file> gets the walk's timings and costs as JSON. Exits 0 on PASS. Requests go
# through curl with their headers and body on its stdin. The token, the model key, the generated AGENTRUN_TOKEN and
# AGENTRUN_SEAL_KEY and the setup code are never printed.
exec node "$(dirname "$0")/publish-and-walk.mjs" "$@"

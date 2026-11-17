#!/bin/sh
# AgentRun's Railway template: published from deploy/railway/template.json and walked. Needs node 24 and, for a run
# against Railway, RAILWAY_API_TOKEN in the environment (an account or workspace token; never on the command line).
#
#   RAILWAY_API_TOKEN=... deploy/railway/publish-and-walk.sh WORKSPACE_ID
#       Makes or updates the template from template.json (through the source project agentrun-template-source, which
#       never deploys), deploys it once into a throwaway project, waits for /v2/health, checks that the first visit asks
#       for the setup code and that AGENTRUN_TOKEN works as that code, deletes the project, then publishes the template.
#       Prints the README's button line when it changes. A few cents of usage per run.
#   ... publish-and-walk.sh WORKSPACE_ID --walk CODE       walks the template CODE and publishes nothing (a release's check)
#   ... publish-and-walk.sh WORKSPACE_ID --template CODE   walks and publishes CODE, a template made in Railway's editor
#   deploy/railway/publish-and-walk.sh --dry-run [WORKSPACE_ID]
#       No token, no network: the plan of a first run, every call in order with its variables, against a stand-in.
#   deploy/railway/publish-and-walk.sh --check-api
#       No token: every operation the script sends, validated by Railway's live GraphQL API.
#
# Each run's report is a Verdict line and a table of step, result and evidence on stdout (REPORT=<file>: in that file
# too); exits 0 on PASS. The token, the generated AGENTRUN_TOKEN and AGENTRUN_SEAL_KEY and the setup code are never printed.
exec node "$(dirname "$0")/publish-and-walk.mjs" "$@"

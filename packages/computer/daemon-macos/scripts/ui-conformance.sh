#!/usr/bin/env bash
# CI: the computer protocol's ui conformance cases (packages/computer/src/conformance/cases/ui.ts) against the running
# Computerd, through its computerd command, with the ui fixture app installed. Needs packages/computer built.
#
#   scripts/ui-conformance.sh PATH/TO/computerd COMPUTERD_HOME
#
# The run is partial (--only ui), so the CLI's exit code is no verdict here: this fails when a case fails, and a skip
# is reported with its reason. The cases and their results go to $GITHUB_STEP_SUMMARY.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
computer="$(cd "$here/../.." && pwd)"
export COMPUTERD="${1:?usage: ui-conformance.sh PATH/TO/computerd COMPUTERD_HOME}" COMPUTERD_HOME="${2:?}"
report=/tmp/computerd-ci/ui-conformance.json

cd "$computer"
status=0
node dist/conformance/cli.js --provider "$here/conformance.mjs" --only ui --json >"$report" || status=$?
echo "the conformance CLI exited $status (3: a partial run where every case passed; 1: a case failed or a Core case skipped)"
python3 -I "$here/ui-conformance-report.py" "$report"

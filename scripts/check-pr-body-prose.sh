#!/usr/bin/env bash
# Lint a pull request body with this repository's prose rules, the way the
# pr-body job's gh-pr-body-action does: warnings fail as well as errors.
#
# Usage: scripts/check-pr-body-prose.sh BODY
# Exit:  0 no alerts, 1 alerts, 2 the check could not run.
#
# Vale picks its parser and its rules from the file extension, and .vale.ini
# applies the rules to [*.md] alone. A body at a path with no extension, such
# as a mktemp file, or one named .txt, gets no rules at all, and Vale reports
# zero alerts for it. So the body is copied to pr-body.md before Vale reads it,
# whatever its own name is.
#
# Vale exits 0 on warnings, so the verdict comes from the alert count in its
# JSON output, and the exit code only tells "ran" from "could not run".

set -uo pipefail

[[ $# -eq 1 && -n $1 ]] || {
	echo "usage: $0 BODY" >&2
	exit 2
}
body=$1
[[ -f $body ]] || {
	echo "prose: no such file: $body" >&2
	exit 2
}
command -v vale >/dev/null 2>&1 || {
	echo "prose: vale is not installed, so there is no verdict" >&2
	exit 2
}

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
config=$repo_root/.vale.ini

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp -- "$body" "$work/pr-body.md"

vale --no-global --config "$config" "$work/pr-body.md"
status=0
report=$(vale --no-global --config "$config" --output=JSON "$work/pr-body.md" 2>"$work/stderr") || status=$?
if ((status > 1)); then
	echo "prose: vale could not run (exit $status)" >&2
	cat "$work/stderr" >&2
	exit 2
fi
alerts=$(printf '%s' "$report" | jq '[.[] | length] | add // 0') || {
	echo "prose: vale did not return a JSON report" >&2
	exit 2
}

if ((alerts == 0)); then
	echo "prose: 0 alerts in $(basename -- "$body")"
	exit 0
fi
echo "prose: $alerts alert(s) in $(basename -- "$body"); the pr-body job fails on a warning as well as an error"
exit 1

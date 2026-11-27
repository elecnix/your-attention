#!/usr/bin/env bash
# The first job of deploy-cloudflare.yml runs this before anything uploads. It refuses a run that names no mode, and a
# mode the environment's secrets contradict. A hosted deployment signs inbox addresses with INBOX_ID_SECRET, and a
# single-mode Worker answers 404 at every one of those addresses: on 27 November a run that took the old default,
# single, did that to the hosted service for four minutes.
#
# Usage: MODE=<input> INBOX_ID_SECRET_SET=true|false scripts/check-deploy-mode.sh
set -euo pipefail

mode=${MODE:-}
signed=${INBOX_ID_SECRET_SET:-false}

case "$mode" in
	hosted | single) ;;
	*)
		echo "::error::name the mode: run with -f mode=hosted for the hosted service, or -f mode=single for a Worker that serves one inbox. Got '${mode}'."
		exit 1
		;;
esac

if [ "$mode" = single ] && [ "$signed" = true ]; then
	echo "::error::this environment has INBOX_ID_SECRET, so it deploys the hosted service. A single-mode Worker would answer 404 at every inbox address. Run with -f mode=hosted, or remove INBOX_ID_SECRET from the environment if it really serves one inbox."
	exit 1
fi
if [ "$mode" = hosted ] && [ "$signed" != true ]; then
	echo "::error::hosted mode needs INBOX_ID_SECRET in the cloudflare environment, which signs inbox addresses."
	exit 1
fi
echo "deploying in $mode mode"

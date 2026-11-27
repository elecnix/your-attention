#!/usr/bin/env bash
# Tests for check-pr-body-prose.sh. Run `vale sync` first.
#
# The same body must get the same verdict under any file name. A body named
# without .md once passed with 0 alerts because Vale applied no rules to it.

set -uo pipefail

check="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/check-pr-body-prose.sh"
pass=0
fail=0
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

expect() { # status, label, body path
	local want=$1 label=$2 got=0
	"$check" "$3" >"$tmp/out" 2>&1 || got=$?
	if [[ $got == "$want" ]]; then
		pass=$((pass + 1))
		printf 'ok   %s\n' "$label"
	else
		fail=$((fail + 1))
		printf 'FAIL %s (exit %s, wanted %s)\n' "$label" "$got" "$want"
		sed 's/^/     /' "$tmp/out" | tail -5
	fi
}

# ai-tells flags each of these phrases.
slop='This change is a game-changer that will delve into a seamless, robust synergy.'
clean='The pre-pr task now copies the body to a file named pr-body.md.'

for name in body.md body body.txt; do
	printf '%s\n' "$slop" >"$tmp/slop-$name"
	expect 1 "a body with alerts fails when named $name" "$tmp/slop-$name"
	printf '%s\n' "$clean" >"$tmp/clean-$name"
	expect 0 "a body without alerts passes when named $name" "$tmp/clean-$name"
done
expect 2 "a missing body cannot be checked" "$tmp/missing.md"

printf '%d passed, %d failed\n' "$pass" "$fail"
[[ $fail == 0 ]]

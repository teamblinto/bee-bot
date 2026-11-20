#!/bin/bash
# Checks beebot-ci-deploy against a fake sudo in a temp dir: what it refuses, what it hands to the
# update, that the update's output and exit code come back, and that it outlives a client that goes
# away. Touches nothing outside the temp dir.
#   bash deploy/beebot-ci-deploy.test.sh
set -euo pipefail
script=$(dirname "$(readlink -f "$0")")/beebot-ci-deploy
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
mkdir "$t/bin" "$t/home"
cat >"$t/bin/sudo" <<'EOF'
#!/bin/bash
echo "$*" >"$HOME/../args"
tar -tzf "${!#}" >/dev/null
echo "updating"
sleep "${FAKE_SLEEP:-0}"
touch "$HOME/../done"
exit "${FAKE_RC:-0}"
EOF
chmod +x "$t/bin/sudo"
mkdir "$t/src" && echo v >"$t/src/VERSION" && tar -czf "$t/good.tar.gz" -C "$t" src
echo "not a tarball" >"$t/bad"

fail() {
	echo "FAIL: $*" >&2
	exit 1
}
# run <expected exit> <SSH_ORIGINAL_COMMAND> <stdin file>
run() {
	rm -f "$t/args"
	local rc=0
	HOME=$t/home PATH=$t/bin:$PATH SSH_ORIGINAL_COMMAND=$2 bash "$script" <"$3" 2>"$t/err" || rc=$?
	[ "$rc" = "$1" ] || fail "'$2' < ${3##*/} exited $rc, not $1: $(cat "$t/err")"
	grep -q "live release:" "$t/err" || fail "'$2' < ${3##*/} did not name the live release"
	[ -z "$(ls "$t/home")" ] || fail "'$2' < ${3##*/} left $(ls "$t/home")"
}

export BEEBOT_CURRENT=$t
rc=0
HOME=$t/home PATH=$t/bin:$PATH SSH_ORIGINAL_COMMAND="rm -rf /" bash "$script" <"$t/good.tar.gz" 2>/dev/null || rc=$?
[ "$rc" = 2 ] && [ ! -e "$t/args" ] || fail "an unknown command was not refused"
run 1 "" /dev/null
run 1 "" "$t/bad"
[ ! -e "$t/args" ] || fail "a bad upload reached sudo"

# Not installed yet: the release goes to beebot-ci-install, and force-fail has nothing to roll back.
export BEEBOT_CURRENT=$t/none
run 0 "" "$t/good.tar.gz"
[ "$(cat "$t/args")" = "-n /usr/local/sbin/beebot-ci-install $t/home/release.tar.gz" ] || fail "sudo got: $(cat "$t/args")"
run 2 force-fail "$t/good.tar.gz"
[ ! -e "$t/args" ] || fail "force-fail without Bee Bot reached sudo"

export BEEBOT_CURRENT=$t
run 0 "" "$t/good.tar.gz"
[ "$(cat "$t/args")" = "-n /usr/local/sbin/beebot update $t/home/release.tar.gz" ] || fail "sudo got: $(cat "$t/args")"
FAKE_RC=1 run 1 force-fail "$t/good.tar.gz"
[ "$(cat "$t/args")" = "-n /usr/bin/env BEEBOT_UPDATE_FORCE_FAIL=1 /usr/local/sbin/beebot update $t/home/release.tar.gz" ] ||
	fail "sudo got: $(cat "$t/args")"
FAKE_RC=2 run 2 "" "$t/good.tar.gz"
grep -q updating "$t/err" || fail "the update's output was not streamed back"

# The client goes away mid-update: everything in the connection's process group is killed, and the
# update still finishes.
rm -f "$t/done" "$t/args"
(HOME=$t/home PATH=$t/bin:$PATH SSH_ORIGINAL_COMMAND="" FAKE_SLEEP=2 exec setsid bash "$script" <"$t/good.tar.gz" >/dev/null 2>&1) &
client=$!
for _ in $(seq 50); do [ -e "$t/args" ] && break; sleep 0.1; done
kill -KILL -- "-$client" 2>/dev/null || fail "the client's process group was gone before the update began"
wait "$client" 2>/dev/null || true
for _ in $(seq 50); do [ -e "$t/done" ] && break; sleep 0.1; done
[ -e "$t/done" ] || fail "the update died with its client"
for _ in $(seq 20); do [ ! -e "$t/home/release.tar.gz" ] && break; sleep 0.1; done
[ -z "$(ls "$t/home")" ] || fail "an update without its client left $(ls "$t/home")"
echo "beebot-ci-deploy: ok"

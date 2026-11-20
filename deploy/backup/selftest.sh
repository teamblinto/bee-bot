#!/bin/bash
# Runs beebot-backup against a fake host in a temp dir, as root, with restic and sqlite3 installed:
# backs up a cell while its database is being written, checks what the backup holds, restores, and
# shows a damaged repository fails verification. Touches nothing outside the temp dir.
set -euo pipefail
here=$(dirname "$(readlink -f "$0")")
t=$(mktemp -d)
writer=
cleanup() {
	[ -z "$writer" ] || kill "$writer" 2>/dev/null || true
	rm -rf "$t"
}
trap cleanup EXIT
chmod 0711 "$t"
fail() {
	echo "FAIL: $*" >&2
	exit 1
}

export BEEBOT_BACKUP_ROOT=$t/host BEEBOT_BACKUP_CONF=$t/conf BEEBOT_BACKUP_CHECK_SUBSET=100%
export RESTIC_REPOSITORY=$t/repo RESTIC_CACHE_DIR=$t/cache RESTIC_PASSWORD_FILE=$t/conf/key
cell=bb0123456789
home=$t/host/var/lib/beebot/cells/$cell
data=$home/data
db=$data/beebot.db
# As the cell, in a mount namespace where its home is the only entry in cells/, as its unit sees it:
# like on a real host, only root can pass through cells/.
in_home='exec 3<"$1" && mount -t tmpfs -o mode=0755 tmpfs "${1%/*}" && mkdir "$1" &&
	mount --no-canonicalize --bind /proc/self/fd/3 "$1" && exec 3<&- && shift &&
	exec setpriv --reuid=nobody --regid=nogroup --clear-groups "$@"'
as_cell() { unshare --mount bash -c "$in_home" - "$@"; } # <home> command...
# The database is only ever opened as the cell, as beebotd would.
q() { as_cell "$home" sqlite3 -cmd ".timeout 5000" "$db" "$1"; }

install -d -m 0700 "$t/conf"
head -c 48 /dev/urandom | base64 -w 0 >"$t/conf/key"
restic init -q
install -d -m 0755 "$t/host/var/lib/beebot" "$t/host/etc/beebot/creds" "$t/host/etc/systemd/system/beebot-$cell.slice.d"
install -d -m 0700 "$t/host/var/lib/beebot/cells"
install -d -m 0700 "$t/host/var/lib/beebot/gateway"
echo BEEBOT_PUBLIC_ORIGIN=https://bee.test >"$t/host/etc/beebot/beebot.env"
echo sealed >"$t/host/etc/beebot/creds/$cell.vault-key.cred"
echo "[Slice]" >"$t/host/etc/systemd/system/beebot-$cell.slice.d/quota.conf"
sqlite3 "$t/host/var/lib/beebot/gateway/gateway.db" "PRAGMA journal_mode=WAL; CREATE TABLE members(cell); INSERT INTO members VALUES('$cell');" >/dev/null
install -d -m 0700 -o nobody -g nogroup "$home"
as_cell "$home" mkdir -p "$data/bots/b1/workspace/.claude" "$data/credentials/acct1" "$data/runtime"
as_cell "$home" sh -c "echo hello >'$data/bots/b1/workspace/notes.txt'"
as_cell "$home" sh -c "echo SECRET >'$data/credentials/acct1/.credentials.json'"
as_cell "$home" sh -c "echo SECRET >'$data/bots/b1/workspace/.claude/.credentials.json'"
as_cell "$home" sqlite3 "$db" "PRAGMA journal_mode=WAL; CREATE TABLE t(id INTEGER PRIMARY KEY, v);" >/dev/null
install -d -m 0755 "$t/host/etc/systemd/system/beebotd@$cell.service.d"
echo "[Service]" >"$t/host/etc/systemd/system/beebotd@$cell.service.d/limits.conf"
# Hostile cells: one whose database can't be read, one whose database is a FIFO.
bad=bb0000000bad fifo=bb00000f1f00
for other in "$bad" "$fifo"; do
	install -d -m 0700 -o nobody -g nogroup "$t/host/var/lib/beebot/cells/$other"
	as_cell "$t/host/var/lib/beebot/cells/$other" mkdir "$t/host/var/lib/beebot/cells/$other/data"
done
as_cell "$t/host/var/lib/beebot/cells/$bad" sh -c "head -c 8192 /dev/urandom >'$t/host/var/lib/beebot/cells/$bad/data/beebot.db'"
as_cell "$t/host/var/lib/beebot/cells/$fifo" mkfifo "$t/host/var/lib/beebot/cells/$fifo/data/beebot.db"

# beebotd stand-in: keeps writing while the backup runs. Exec'd, so $! is the writer itself.
(exec unshare --mount bash -c "$in_home" - "$home" \
	bash -c "while [ -e '$db' ]; do sqlite3 -cmd '.timeout 5000' '$db' \"INSERT INTO t(v) VALUES(randomblob(2000))\"; done") &
writer=$!
sleep 1
before=$(q 'SELECT count(*) FROM t')
if timeout 300 "$here/beebot-backup" backup 2>"$t/err"; then fail "backup passed with a cell left out"; fi
grep -q "could not be copied: $bad\$" "$t/err" || fail "backup didn't name the one cell it left out"
kill "$writer"
wait "$writer" 2>/dev/null || true
writer=
after=$(q 'SELECT count(*) FROM t')
[ "$(stat -c %U "$db-wal" 2>/dev/null || echo nobody)" = nobody ] || fail "backup left a root-owned -wal"

listing=$(restic ls latest)
grep -q '\.credentials\.json' <<<"$listing" && fail "a .credentials.json is in the backup"
grep -q "$data/credentials" <<<"$listing" && fail "the credentials folder is in the backup"
grep -qx "$db" <<<"$listing" && fail "the live database file is in the backup"
grep -qx "$t/host/var/lib/beebot-backup/stage$db" <<<"$listing" || fail "no database snapshot in the backup"
grep -qx "$data/bots/b1/workspace/notes.txt" <<<"$listing" || fail "workspace missing"
grep -qx "$t/host/etc/beebot/creds/$cell.vault-key.cred" <<<"$listing" || fail "vault cred missing"
grep -qx "$t/host/etc/systemd/system/beebotd@$cell.service.d/limits.conf" <<<"$listing" || fail "box cap and budget missing"
grep -q "/cells/$bad" <<<"$listing" && fail "the cell whose database failed is in the backup"
grep -qx "$t/host/var/lib/beebot/cells/$fifo/data" <<<"$listing" || fail "the FIFO cell's data is missing"
[ ! -e "$t/host/var/lib/beebot-backup/stage" ] || fail "plaintext snapshots left on disk"
echo "ok: backup holds workspace, config, limits and a database snapshot; no logins; a bad cell is only left out"

# Changes after the backup, then a restore of the cell undoes them and keeps the logins.
q "INSERT INTO t(v) VALUES('after-backup')"
rm "$data/bots/b1/workspace/notes.txt"
"$here/beebot-backup" restore "$cell" || fail "restore $cell"
[ "$(q 'PRAGMA integrity_check')" = ok ] || fail "restored database is corrupt"
n=$(q 'SELECT count(*) FROM t')
[ "$n" -ge "$before" ] && [ "$n" -le "$after" ] || fail "restored $n rows, expected $before..$after"
[ "$(q "SELECT count(*) FROM t WHERE v = 'after-backup'")" = 0 ] || fail "restore kept a later row"
[ "$(cat "$data/bots/b1/workspace/notes.txt")" = hello ] || fail "workspace file not restored"
[ -f "$data/credentials/acct1/.credentials.json" ] || fail "restore dropped the cell's logins"
[ "$(stat -c %U "$db")" = nobody ] || fail "restored database not owned by the cell"
q "INSERT INTO t(v) VALUES('cell can write')" || fail "cell can't write its restored database"
echo "ok: restore $cell reproduced the database ($n rows, between $before and $after) and kept logins"

sqlite3 "$t/host/var/lib/beebot/gateway/gateway.db" "DELETE FROM members"
rm "$t/host/etc/beebot/beebot.env"
"$here/beebot-backup" restore all || fail "restore all"
[ "$(sqlite3 "$t/host/var/lib/beebot/gateway/gateway.db" 'SELECT cell FROM members')" = "$cell" ] || fail "gateway database not restored"
[ -s "$t/host/etc/beebot/beebot.env" ] || fail "config not restored"
echo "ok: restore all brought back the gateway database and config"

# A cell gone from the host: its vault key comes back, and the restore says what to run.
rm -rf "$home" "$t/host/etc/beebot/creds/$cell.vault-key.cred"
if "$here/beebot-backup" restore all 2>"$t/err"; then fail "restore all passed with a cell missing"; fi
grep -q "beebot-provision user add $cell" "$t/err" || fail "restore all didn't name the missing cell"
[ -f "$t/host/etc/beebot/creds/$cell.vault-key.cred" ] || fail "missing cell's vault key not restored"
echo "ok: restore all brings back a missing cell's vault key and names it"

pack=$(find "$t/repo/data" -type f | head -n 1)
printf 'garbage' | dd of="$pack" bs=1 seek=100 conv=notrunc status=none
if "$here/beebot-backup" verify >/dev/null 2>&1; then fail "a damaged repository verified"; fi
echo "ok: a damaged repository fails verification"
echo PASS

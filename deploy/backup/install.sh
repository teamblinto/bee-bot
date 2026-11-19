#!/bin/bash
# Installs Bee Bot's nightly backup, as root. Safe to run again: an existing key, config and
# repository are kept.
set -euo pipefail
here=$(dirname "$(readlink -f "$0")")
conf=/etc/beebot-backup

missing=()
command -v restic >/dev/null || missing+=(restic)
command -v sqlite3 >/dev/null || missing+=(sqlite3)
[ ${#missing[@]} -eq 0 ] || DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${missing[@]}"

install -d -m 0700 "$conf"
if [ ! -s "$conf/key" ]; then
	(umask 077 && head -c 48 /dev/urandom | base64 -w 0 >"$conf/key")
	echo "beebot-backup: generated $conf/key. Copy it somewhere off this host now: without it no backup can be read." >&2
fi
chmod 0600 "$conf/key"
if [ ! -e "$conf/backup.env" ]; then
	cat >"$conf/backup.env" <<'EOF'
# Any restic repository: a local path (the default), sftp:user@host:/path, s3:..., rest:...
# Credentials for it (e.g. AWS_ACCESS_KEY_ID) go here too; this file is root-only and never backed up.
#RESTIC_REPOSITORY=/var/backups/beebot/restic
EOF
fi
chmod 0600 "$conf/backup.env"

install -m 0755 "$here/beebot-backup" /usr/local/sbin/beebot-backup
install -m 0644 "$here/beebot-backup.service" "$here/beebot-backup.timer" /etc/systemd/system/

(
	set -a
	. "$conf/backup.env"
	export RESTIC_REPOSITORY=${RESTIC_REPOSITORY:-/var/backups/beebot/restic} RESTIC_PASSWORD_FILE=$conf/key
	case $RESTIC_REPOSITORY in /*) install -d -m 0700 "$(dirname "$RESTIC_REPOSITORY")" ;; esac
	restic cat config >/dev/null 2>&1 || restic init
)

systemctl daemon-reload
systemctl enable --now beebot-backup.timer

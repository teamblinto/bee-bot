#!/bin/bash
# Takes Bee Bot off this host, as root: every cell and its data, the gateway, the units, the fence
# table, the users and groups, the files and drop-ins install.sh lists. It can't be undone.
#   sudo bash /opt/beebot/current/deploy/uninstall.sh --yes
# Kept: the packages (and NodeSource's apt source, which keeps nodejs updated), and the backups in
# /etc/beebot-backup and /var/backups/beebot, which it names at the end for you to delete.
set -euo pipefail
cell_pattern='^bb[0-9a-f]{10}$'

# The whole file is read before it runs: it deletes the folder it lives in.
main() {
	[ "${1:-}" = --yes ] || { echo "usage: uninstall.sh --yes   (deletes every user's data)" >&2; exit 2; }
	[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

	systemctl disable --now beebot-backup.timer beebot-backup.service beebot-gateway.service 2>/dev/null || true
	local cell image
	for cell in $(cells); do
		# Stops its socket, service and slices, then removes its user, subids, data, creds, drop-ins.
		/usr/local/sbin/beebot-provision user delete "$cell" --confirm ||
			{ echo "could not delete cell $cell; fix that and run this again" >&2; exit 1; }
	done
	# Each cell's name stays denied in these until now, so its uid could never run a job.
	for file in /etc/cron.deny /etc/at.deny; do
		[ -f "$file" ] || continue
		sed -i -E "/$cell_pattern/d" "$file"
		# install.sh made cron.deny when it was missing; empty, it means what no file means.
		[ "$file" != /etc/cron.deny ] || [ -s "$file" ] || rm -f "$file"
	done

	systemctl disable --now beebot-fence.service 2>/dev/null || true
	nft delete table inet beebot_fence 2>/dev/null || true

	if grep -qF "# Written by Bee Bot's install.sh" /etc/caddy/Caddyfile 2>/dev/null; then
		systemctl disable --now caddy.service 2>/dev/null || true
		rm -f /etc/caddy/Caddyfile
	fi
	! id -nG caddy 2>/dev/null | grep -qw beebot-web || gpasswd -d caddy beebot-web >/dev/null
	! getent passwd beebot-gw >/dev/null || userdel beebot-gw
	for group in beebot-gw beebot-web beebot-cells; do
		! getent group "$group" >/dev/null || groupdel "$group"
	done

	image=$(sed -n 's/^BEEBOT_BOX_IMAGE=//p' /etc/beebot/box-image.env 2>/dev/null || true)
	[ -z "$image" ] || podman rmi -f "$image" >/dev/null 2>&1 || true

	# Only when install.sh made it: an empty /var/lib/cni that was there before stays.
	[ ! -e /var/lib/beebot/made-var-lib-cni ] || rmdir /var/lib/cni 2>/dev/null || true
	rm -rf --one-file-system \
		/etc/systemd/system/beebot-fence.service /etc/systemd/system/beebot-gateway.service \
		/etc/systemd/system/beebotd@.service /etc/systemd/system/beebotd@.socket \
		/etc/systemd/system/beebot-backup.service /etc/systemd/system/beebot-backup.timer \
		/etc/systemd/system/beebot-*.slice.d /etc/systemd/system/beebotd@*.service.d \
		/etc/systemd/resolved.conf.d/beebot.conf /etc/sudoers.d/beebot-provision \
		/usr/local/sbin/beebot /usr/local/sbin/beebot-provision /usr/local/sbin/beebot-backup \
		/etc/beebot /var/lib/beebot /run/beebot /var/lib/beebot-backup /var/cache/beebot-backup \
		/opt/beebot /var/lib/systemd/timers/stamp-beebot-backup.timer
	# The parent of every cell's slice, which systemd made for them.
	systemctl stop beebot.slice 2>/dev/null || true
	systemctl daemon-reload
	systemctl reset-failed 2>/dev/null || true
	systemctl try-restart systemd-resolved.service
	echo "Bee Bot is gone. Backups are kept: /etc/beebot-backup (the key) and /var/backups/beebot; delete them yourself if you won't restore."
}

# Every cell a user or a home says exists, so a half-made one goes too.
cells() {
	{
		awk -F: '$3 >= 50000 && $3 < 51000 && $6 == "/var/lib/beebot/cells/" $1 { print $1 }' /etc/passwd
		ls /var/lib/beebot/cells 2>/dev/null
	} | grep -E "$cell_pattern" | sort -u || true
}

main "$@"
exit

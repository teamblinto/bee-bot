#!/bin/bash
# Puts a release's users, units, fence and sudoers rule in place, as root. Run by install.sh and by
# `beebot update` (again with the old release when it rolls back). Safe to run again.
# Usage: system.sh <release dir>
set -euo pipefail
release=$1
system=$release/apps/provision/system

# beebot-gw opens every cell's socket; beebot-web opens only the gateway's, and is Caddy's group.
getent group beebot-gw >/dev/null || groupadd --system beebot-gw
getent group beebot-web >/dev/null || groupadd --system beebot-web
getent passwd beebot-gw >/dev/null ||
	useradd --system --gid beebot-gw --home-dir /var/lib/beebot/gateway --no-create-home \
		--shell /usr/sbin/nologin beebot-gw
install -d -m 0755 /var/lib/beebot
install -d -m 0711 /var/lib/beebot/cells
# Podman 4's rootless netns mounts a tmpfs on the nearest existing of /var/lib/cni, /var/lib, ...;
# landing on /var/lib it hides the cells' homes, and with them their network configs. The marker
# tells uninstall.sh it may remove the directory.
if [ ! -e /var/lib/cni ]; then
	install -d -m 0755 /var/lib/cni
	touch /var/lib/beebot/made-var-lib-cni
fi
install -d -m 0700 /etc/beebot/creds
install -m 0644 "$system/containers.conf" /etc/beebot/
install -m 0644 "$system/beebotd@.service" "$system/beebotd@.socket" "$system/beebot-fence.service" \
	"$system/beebot-gateway.service" /etc/systemd/system/
install -d -m 0755 /etc/systemd/resolved.conf.d
install -m 0644 "$system/resolved.conf" /etc/systemd/resolved.conf.d/beebot.conf
systemctl try-restart systemd-resolved.service

# The fence lets cells reach this host's DNS resolvers and nothing else local.
resolvers=$(awk '$1 == "nameserver" && $2 ~ /^[0-9.]+$/ { printf "%s%s", sep, $2; sep = ", " }' /etc/resolv.conf)
sed "s/elements = { 127.0.0.53 }/elements = { ${resolvers:-127.0.0.53} }/" "$system/fence.nft" >/etc/beebot/fence.nft.new
nft -c -f /etc/beebot/fence.nft.new
mv /etc/beebot/fence.nft.new /etc/beebot/fence.nft

visudo -cf "$system/sudoers" >/dev/null
install -m 0440 "$system/sudoers" /etc/sudoers.d/beebot-provision
# Through current, so an update or rollback moves them along with the code.
ln -sfn /opt/beebot/current/apps/provision/src/beebot-provision.ts /usr/local/sbin/beebot-provision
ln -sfn /opt/beebot/current/deploy/beebot /usr/local/sbin/beebot

systemctl daemon-reload
systemctl enable --quiet beebot-fence.service beebot-gateway.service
# Cells from before beebotd@.socket: an enabled cell gets its socket enabled too. Their old socket
# folders, which the cell owned, go.
for wanted in /etc/systemd/system/multi-user.target.wants/beebotd@bb*.service; do
	cell=${wanted##*/beebotd@}
	cell=${cell%.service}
	if [[ $cell =~ ^bb[0-9a-f]{10}$ ]]; then
		systemctl enable --quiet "beebotd@$cell.socket"
	fi
done
install -d -m 0711 /run/beebot
install -d -g beebot-gw -m 0710 /run/beebot/cells
find /run/beebot/cells -mindepth 1 -maxdepth 1 -type d -name 'bb*' -exec rm -rf --one-file-system -- {} + 2>/dev/null || true
systemctl start beebot-fence.service
# Not a restart of the fence unit, which would restart every cell (Requires=): the file swaps the
# table in one transaction.
nft -f /etc/beebot/fence.nft

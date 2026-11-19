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
install -d -m 0700 /etc/beebot/creds
install -m 0644 "$system/containers.conf" /etc/beebot/
install -m 0644 "$system/beebotd@.service" "$system/beebot-fence.service" \
	"$system/beebot-gateway.service" /etc/systemd/system/

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
systemctl start beebot-fence.service
# Not a restart of the fence unit, which would restart every cell (Requires=): the file swaps the
# table in one transaction.
nft -f /etc/beebot/fence.nft

#!/bin/bash
# Sets up a host for cells, as root, from an installed release (/opt/beebot/current must be
# root-owned all the way, since root runs beebot-provision from it). Safe to run again.
# Usage: install.sh <box-image.tar>   (from `podman save` of the image runSpec.json names)
set -euo pipefail
here=$(dirname "$(readlink -f "$0")")
release=/opt/beebot/current

if [ ! -s /etc/beebot/beebot.env ]; then
	echo "write BEEBOT_PUBLIC_ORIGIN=https://<host> to /etc/beebot/beebot.env first; it holds no secrets, every cell reads it" >&2
	exit 1
fi
# beebot-gw opens every cell's socket; beebot-web opens only the gateway's, and is Caddy's group.
getent group beebot-gw >/dev/null || groupadd --system beebot-gw
getent group beebot-web >/dev/null || groupadd --system beebot-web
getent passwd beebot-gw >/dev/null ||
	useradd --system --gid beebot-gw --home-dir /var/lib/beebot/gateway --no-create-home 		--shell /usr/sbin/nologin beebot-gw
install -d -m 0755 /var/lib/beebot
install -d -m 0711 /var/lib/beebot/cells
install -d -m 0700 /etc/beebot/creds
install -m 0644 "$here/containers.conf" /etc/beebot/
install -m 0644 "$here/beebotd@.service" "$here/beebot-fence.service" "$here/beebot-gateway.service" 	/etc/systemd/system/
if [ ! -s /etc/beebot/gateway.env ]; then
	(umask 077 && echo "GATEWAY_AUTH_SECRET=$(head -c 48 /dev/urandom | base64 -w 0)" >/etc/beebot/gateway.env)
fi
chmod 0600 /etc/beebot/gateway.env

# Every cell loads the box image from here into its own store when it starts without it.
install -m 0644 "$1" /var/lib/beebot/box-image.tar
image=$(sed -n 's/^ *"image": *"\([^"]*\)".*/\1/p' "$release/images/box/runSpec.json" | head -n 1)
echo "BEEBOT_BOX_IMAGE=$image" >/etc/beebot/box-image.env

# The fence lets cells reach this host's DNS resolvers and nothing else local.
resolvers=$(awk '$1 == "nameserver" && $2 ~ /^[0-9.]+$/ { printf "%s%s", sep, $2; sep = ", " }' /etc/resolv.conf)
sed "s/elements = { 127.0.0.53 }/elements = { ${resolvers:-127.0.0.53} }/" "$here/fence.nft" >/etc/beebot/fence.nft
nft -c -f /etc/beebot/fence.nft

visudo -cf "$here/sudoers" >/dev/null
install -m 0440 "$here/sudoers" /etc/sudoers.d/beebot-provision
ln -sfn "$release/apps/provision/src/beebot-provision.ts" /usr/local/sbin/beebot-provision

systemctl daemon-reload
systemctl enable beebot-fence.service beebot-gateway.service
systemctl restart beebot-fence.service beebot-gateway.service
getent group beebot-web | grep -qw caddy ||
	echo "add Caddy to beebot-web (usermod -aG beebot-web caddy), never to beebot-gw" >&2

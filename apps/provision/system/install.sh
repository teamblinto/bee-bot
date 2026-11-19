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
getent group beebot-gw >/dev/null || groupadd --system beebot-gw
install -d -m 0755 /var/lib/beebot
install -d -m 0711 /var/lib/beebot/cells
install -d -m 0700 /etc/beebot/creds
install -m 0644 "$here/containers.conf" /etc/beebot/
install -m 0644 "$here/beebotd@.service" "$here/beebot-fence.service" /etc/systemd/system/

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
systemctl enable beebot-fence.service
systemctl restart beebot-fence.service

#!/bin/bash
# Makes /var/lib/beebot/box-image.tar hold the box image a release names, as root. Each cell loads
# it into its own store when it starts without that image. The image is about 1.4 GB, so releases
# don't carry it: it is built here, once per image tag, unless a `podman save` of it is given.
# Usage: box-image.sh <release dir> [box-image.tar]
set -euo pipefail
release=$1
given=${2:-}
tar=/var/lib/beebot/box-image.tar
image=$(sed -n 's/^ *"image": *"\([^"]*\)".*/\1/p' "$release/images/box/runSpec.json" | head -n 1)
if [ -z "$image" ]; then
	echo "no image in $release/images/box/runSpec.json" >&2
	exit 1
fi
install -d -m 0755 /var/lib/beebot

if [ -n "$given" ]; then
	# podman save writes the tag into the archive's manifest.
	if ! tar -xOf "$given" manifest.json 2>/dev/null | grep -qF "\"$image\""; then
		echo "$given is not a podman save of $image" >&2
		exit 1
	fi
	install -m 0644 "$given" "$tar.new"
elif [ -s "$tar" ] && grep -qxF "BEEBOT_BOX_IMAGE=$image" /etc/beebot/box-image.env 2>/dev/null; then
	exit 0
else
	echo "building the box image $image; this takes a while" >&2
	# Host network: root's default bridge would add netavark chains to the host's iptables tables.
	podman build --network=host -t "$image" "$release/images/box"
	rm -f "$tar.new"
	podman save -q -o "$tar.new" "$image"
	chmod 0644 "$tar.new"
fi
mv "$tar.new" "$tar"
echo "BEEBOT_BOX_IMAGE=$image" >/etc/beebot/box-image.env.new
mv /etc/beebot/box-image.env.new /etc/beebot/box-image.env

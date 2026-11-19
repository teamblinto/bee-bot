#!/bin/bash
# Installs Bee Bot on a fresh Ubuntu 24.04 host, as root, from an unpacked release:
#   sudo ./deploy/install.sh --domain bee.example.com --admin-email you@example.com [--box-image box.tar]
# --box-image takes a `podman save` of the image images/box/runSpec.json names; without it the
# image is built here. An IP address or localhost as --domain gets Caddy's own CA, for testing.
# Safe to run again with the same release. Later releases go in with `beebot update`.
set -euo pipefail
usage() {
	echo "usage: install.sh --domain <host> [--admin-email <email>] [--box-image <box.tar>]" >&2
	exit 2
}
here=$(cd "$(dirname "$0")/.." && pwd -P)
domain="" email="" box=""
while [ $# -gt 0 ]; do
	case $1 in
	--domain) domain=${2:-} && shift 2 ;;
	--admin-email) email=${2:-} && shift 2 ;;
	--box-image) box=$(readlink -f "${2:-}") && shift 2 ;;
	*) usage ;;
	esac
done
# It goes into the Caddyfile and every cell's origin.
[[ $domain =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || usage
[ -z "$email" ] || [[ $email =~ ^[^[:space:]@]+@[^[:space:]@]+$ ]] || usage
if [ "$(id -u)" != 0 ]; then
	echo "run as root" >&2
	exit 1
fi
version=$(cat "$here/VERSION")
[[ $version =~ ^[A-Za-z0-9._-]+$ ]] || { echo "bad VERSION in $here" >&2; exit 1; }

# Packages. Node comes from NodeSource's apt repository, held to 22.x: Ubuntu's is too old for the
# type stripping beebot-provision runs on.
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg
if [ ! -s /usr/share/keyrings/nodesource.gpg ]; then
	curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key |
		gpg --dearmor -o /usr/share/keyrings/nodesource.gpg.new
	mv /usr/share/keyrings/nodesource.gpg.new /usr/share/keyrings/nodesource.gpg
fi
cat >/etc/apt/sources.list.d/nodesource.sources <<EOF
Types: deb
URIs: https://deb.nodesource.com/node_22.x
Suites: nodistro
Components: main
Architectures: $(dpkg --print-architecture)
Signed-By: /usr/share/keyrings/nodesource.gpg
EOF
printf 'Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n' >/etc/apt/preferences.d/nodejs
apt-get update -q
apt-get install -y -q podman uidmap nftables passt caddy nodejs
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)' ||
	{ echo "Node $(node -v) is too old: 22.18 or later runs beebot-provision" >&2; exit 1; }

# The release, root-owned all the way: root runs beebot-provision from it.
release=/opt/beebot/releases/$version
current=$(readlink -f /opt/beebot/current || true)
if [ -n "$current" ] && [ "$current" != "$release" ]; then
	echo "$(basename "$current") is installed; to move to $version run: beebot update <release.tar.gz>" >&2
	exit 1
fi
install -d -m 0755 /opt/beebot /opt/beebot/releases
if [ ! -d "$release" ]; then
	rm -rf "$release.new"
	cp -R "$here" "$release.new"
	chown -R root:root "$release.new"
	chmod -R u+rwX,go+rX,go-w "$release.new"
	chmod 0755 "$release.new/deploy/beebot" "$release.new/apps/provision/src/beebot-provision.ts"
	mv "$release.new" "$release"
fi
ln -sfn "$release" /opt/beebot/current.new
mv -T /opt/beebot/current.new /opt/beebot/current

# Cells read beebot.env, so it holds no secrets; gateway.env is root's alone.
install -d -m 0755 /etc/beebot
echo "BEEBOT_PUBLIC_ORIGIN=https://$domain" >/etc/beebot/beebot.env
if [ ! -s /etc/beebot/gateway.env ]; then
	(umask 077 && echo "GATEWAY_AUTH_SECRET=$(head -c 48 /dev/urandom | base64 -w 0)" >/etc/beebot/gateway.env)
fi
chmod 0600 /etc/beebot/gateway.env

bash "$release/deploy/box-image.sh" "$release" "$box"
bash "$release/deploy/system.sh" "$release"
[ ! -f "$release/deploy/backup/install.sh" ] || bash "$release/deploy/backup/install.sh"

# Caddy reaches the gateway's socket through beebot-web, and never joins beebot-gw.
usermod -aG beebot-web caddy
tls=""
if [[ $domain =~ ^[0-9.]+$ || $domain == localhost || $domain == *.localhost ]]; then
	tls="tls internal"
fi
cat >/etc/caddy/Caddyfile <<EOF
# Written by Bee Bot's install.sh, which writes it again when it runs.
# admin off: there is no admin API to reload through, so restart Caddy to apply a change.
{
	admin off
}

$domain {
	$tls
	reverse_proxy unix//run/beebot/gateway/gateway.sock
}
EOF
checked=$(caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1) || { echo "$checked" >&2; exit 1; }
systemctl enable --quiet caddy.service
systemctl restart beebot-gateway.service caddy.service

health() {
	runuser -u beebot-gw -- curl -sf --max-time 5 --unix-socket /run/beebot/gateway/gateway.sock \
		http://gateway/_gateway/health | grep -q '"ok":true'
}
for _ in $(seq 30); do
	if health; then break; fi
	sleep 1
done
health || { echo "the gateway did not come up: journalctl -u beebot-gateway" >&2; exit 1; }

has_admin=$(cd / && runuser -u beebot-gw -- node --disable-warning=ExperimentalWarning -e '
	const db = new (require("node:sqlite").DatabaseSync)(process.argv[1], { readOnly: true });
	console.log(db.prepare("SELECT count(*) AS n FROM member WHERE admin = 1").get().n);
' /var/lib/beebot/gateway/gateway.db)
echo "Bee Bot $version is running at https://$domain"
if [ "$has_admin" != 0 ]; then
	echo "An admin already exists. Invite people with: sudo beebot invite <email>"
elif [ -n "$email" ]; then
	echo "Create the admin account at: $(/usr/local/sbin/beebot invite "$email" --admin)"
else
	echo "No admin yet: run this again with --admin-email <email>" >&2
fi

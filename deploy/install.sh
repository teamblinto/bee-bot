#!/bin/bash
# Installs Bee Bot on an Ubuntu 24.04 host, as root, from an unpacked release:
#   sudo ./deploy/install.sh --domain bee.example.com --admin-email you@example.com [--box-image box.tar]
#     [--https-port <n>] [--http-port <n>]
# --box-image takes a `podman save` of the image images/box/runSpec.json names; without it the
# image is built here. An IP address or localhost as --domain gets Caddy's own CA, for testing.
# Caddy serves HTTPS on --https-port (443) and redirects HTTP from --http-port, which is 80 when
# HTTPS is on 443 and otherwise off unless given. Away from 443 a public certificate can't be
# issued, so that suits an IP or localhost domain, or a proxy in front.
# Safe to run again with the same release. Later releases go in with `beebot update`;
# deploy/uninstall.sh takes everything below away again.
#
# What this changes on the host, and nothing else (it never touches other nftables tables, other
# apps under /opt, or the nftables.service that would load /etc/nftables.conf):
# - Packages: ca-certificates curl gnupg podman uidmap nftables passt caddy restic sqlite3, and
#   nodejs 22 from NodeSource unless Node 22.18+ is already /usr/bin/node: then the apt source
#   /etc/apt/sources.list.d/nodesource.sources, its key /usr/share/keyrings/nodesource.gpg
#   (fingerprint checked) and the pin /etc/apt/preferences.d/nodejs.
# - Users and groups: beebot-gw, beebot-web; one system user, group and subuid/subgid range per
#   cell (uids 50000-50999), made later by beebot-provision. Caddy's user joins beebot-web.
# - Files: /opt/beebot, /etc/beebot, /var/lib/beebot, /etc/beebot-backup, /var/backups/beebot,
#   /usr/local/sbin/{beebot,beebot-provision,beebot-backup}, /etc/caddy/Caddyfile (refused when
#   another Caddyfile is there), the box image in root's Podman store.
# - Drop-ins: /etc/sudoers.d/beebot-provision, /etc/systemd/resolved.conf.d/beebot.conf (LLMNR and
#   mDNS off), each cell's name in /etc/cron.deny (made if missing) and /etc/at.deny (if present).
# - Units: beebot-fence.service, beebot-gateway.service, beebotd@.service, beebotd@.socket,
#   beebot-backup.service and .timer, cells' drop-ins beebot-<cell>.slice.d and
#   beebotd@<cell>.service.d; caddy.service enabled.
# - Firewall: the nftables table inet beebot_fence alone, loaded by beebot-fence.service.
set -euo pipefail
usage() {
	echo "usage: install.sh --domain <host> [--admin-email <email>] [--box-image <box.tar>] [--https-port <n>] [--http-port <n>]" >&2
	exit 2
}
here=$(cd "$(dirname "$0")/.." && pwd -P)
domain="" email="" box="" https_port=443 http_port=""
while [ $# -gt 0 ]; do
	case $1 in
	--domain) domain=${2:-} && shift 2 ;;
	--admin-email) email=${2:-} && shift 2 ;;
	--box-image) box=$(readlink -f "${2:-}") && shift 2 ;;
	--https-port) https_port=${2:-} && shift 2 ;;
	--http-port) http_port=${2:-} && shift 2 ;;
	*) usage ;;
	esac
done
# It goes into the Caddyfile and every cell's origin.
[[ $domain =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || usage
[ -z "$email" ] || [[ $email =~ ^[^[:space:]@]+@[^[:space:]@]+$ ]] || usage
port() { [[ $1 =~ ^[1-9][0-9]{0,4}$ ]] && [ "$1" -le 65535 ]; }
port "$https_port" || usage
[ -z "$http_port" ] || port "$http_port" || usage
[ -n "$http_port" ] || [ "$https_port" != 443 ] || http_port=80
origin=https://$domain
[ "$https_port" = 443 ] || origin=$origin:$https_port
if [ "$(id -u)" != 0 ]; then
	echo "run as root" >&2
	exit 1
fi
version=$(cat "$here/VERSION")
[[ $version =~ ^[A-Za-z0-9._-]+$ ]] || { echo "bad VERSION in $here" >&2; exit 1; }
caddy_marker="# Written by Bee Bot's install.sh"
if [ -s /etc/caddy/Caddyfile ] && ! grep -qF "$caddy_marker" /etc/caddy/Caddyfile &&
	dpkg-query -W -f '${Status}' caddy 2>/dev/null | grep -q 'ok installed'; then
	echo "Caddy here already serves something else (/etc/caddy/Caddyfile); Bee Bot won't replace it" >&2
	exit 1
fi

node_ok() {
	[ -x /usr/bin/node ] && /usr/bin/node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)'
}
# NodeSource's signing key, as https://github.com/nodesource/distributions publishes it.
nodesource_key=6F71F525282841EEDAF851B42F59B5F99B1BE0B4
# One key, and that one.
key_ok() {
	[ "$(gpg --show-keys --with-colons "$1" 2>/dev/null |
		awk -F: '$1 == "pub" { n++ } $1 == "fpr" && !f { f = $10 } END { print n " " f }')" = "1 $nodesource_key" ]
}

# Packages. Node comes from NodeSource's apt repository, held to 22.x: Ubuntu's is too old for the
# type stripping beebot-provision runs on. A Node another app installed is never replaced.
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg
if ! node_ok; then
	if [ -x /usr/bin/node ] && [ ! -f /etc/apt/sources.list.d/nodesource.sources ]; then
		echo "Node $(/usr/bin/node -v) is installed for something else; Bee Bot needs 22.18 or later and won't replace it" >&2
		exit 1
	fi
	if ! key_ok /usr/share/keyrings/nodesource.gpg; then
		rm -f /usr/share/keyrings/nodesource.gpg.new
		curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key |
			gpg --dearmor -o /usr/share/keyrings/nodesource.gpg.new
		key_ok /usr/share/keyrings/nodesource.gpg.new ||
			{ echo "NodeSource's key is not $nodesource_key; refusing it" >&2; exit 1; }
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
	apt-get install -y -q nodejs
	node_ok || { echo "Node $(/usr/bin/node -v) is too old: 22.18 or later runs beebot-provision" >&2; exit 1; }
fi
# The caddy package starts Caddy as it installs, with a Caddyfile that takes :80. Ours goes there
# first and dpkg keeps it, so Caddy only ever listens where Bee Bot says.
caddyfile() {
	local tls="" redirect="http_port $http_port"
	if [[ $domain =~ ^[0-9.]+$ || $domain == localhost || $domain == *.localhost ]]; then
		tls="tls internal"
	fi
	[ -n "$http_port" ] || redirect="auto_https disable_redirects"
	cat <<EOF
$caddy_marker, which writes it again when it runs.
# admin off: there is no admin API to reload through, so restart Caddy to apply a change.
{
	admin off
	https_port $https_port
	$redirect
}

$domain {
	$tls
	reverse_proxy unix//run/beebot/gateway/gateway.sock
}
EOF
}
install -d -m 0755 /etc/caddy
caddyfile >/etc/caddy/Caddyfile
apt-get install -y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold \
	podman uidmap nftables passt caddy

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
echo "BEEBOT_PUBLIC_ORIGIN=$origin" >/etc/beebot/beebot.env
if [ ! -s /etc/beebot/gateway.env ]; then
	(umask 077 && echo "GATEWAY_AUTH_SECRET=$(head -c 48 /dev/urandom | base64 -w 0)" >/etc/beebot/gateway.env)
fi
chmod 0600 /etc/beebot/gateway.env

bash "$release/deploy/box-image.sh" "$release" "$box"
bash "$release/deploy/system.sh" "$release"
[ ! -f "$release/deploy/backup/install.sh" ] || bash "$release/deploy/backup/install.sh"

# Caddy reaches the gateway's socket through beebot-web, and never joins beebot-gw.
usermod -aG beebot-web caddy
caddyfile >/etc/caddy/Caddyfile
checked=$(caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1) || { echo "$checked" >&2; exit 1; }
systemctl enable --quiet caddy.service
systemctl restart beebot-gateway.service
systemctl restart caddy.service ||
	{ echo "Caddy did not start; is port $https_port${http_port:+ or $http_port} taken? journalctl -u caddy" >&2; exit 1; }

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
echo "Bee Bot $version is running at $origin"
if [ "$has_admin" != 0 ]; then
	echo "An admin already exists. Invite people with: sudo beebot invite <email>"
elif [ -n "$email" ]; then
	echo "Create the admin account at: $(/usr/local/sbin/beebot invite "$email" --admin)"
else
	echo "No admin yet: run this again with --admin-email <email>" >&2
fi

#!/bin/bash
# Lets CI install and update Bee Bot on this host, as root, from the deploy folder of a checkout or
# release:
#   sudo bash deploy/ci-deploy-setup.sh <deploy-key.pub> --domain <host> \
#     [--behind-proxy <ip:port> --trusted-proxies <cidr>]
# Makes the unprivileged user beebot-deploy, whose one key (the given public key, which replaces any
# before it) can only run /usr/local/sbin/beebot-ci-deploy: a tarball on stdin into `beebot update`,
# or into beebot-ci-install while Bee Bot isn't installed, which runs install.sh with the options
# given here (kept in /etc/beebot-deploy/install.env). Its sudoers rule allows those commands on one
# fixed path and nothing else. Safe to run again, and running it again from a newer checkout is how
# the installed beebot-ci-deploy and beebot-ci-install get updated: releases don't replace them.
# deploy/uninstall.sh takes it all away.
set -euo pipefail
usage() {
	echo "usage: ci-deploy-setup.sh <deploy-key.pub> --domain <host> [--behind-proxy <ip:port> --trusted-proxies <cidr>]" >&2
	exit 2
}
[ $# -ge 1 ] && [ -f "$1" ] || usage
pubkey=$1
shift
domain="" behind="" trusted=""
while [ $# -gt 0 ]; do
	case $1 in
	--domain) domain=${2:-} && shift 2 ;;
	--behind-proxy) behind=${2:-} && shift 2 ;;
	--trusted-proxies) trusted=${2:-} && shift 2 ;;
	*) usage ;;
	esac
done
# install.sh checks these again; here they are only kept from failing the first deploy.
[[ $domain =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || usage
ipv4='([0-9]{1,3}\.){3}[0-9]{1,3}'
[ -z "$behind$trusted" ] || [[ $behind =~ ^$ipv4:[0-9]{1,5}$ && $trusted =~ ^$ipv4/[0-9]{1,2}$ ]] || usage
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
here=$(dirname "$(readlink -f "$0")")
home=/var/lib/beebot-deploy

# Only the type and the key are kept, so the file can't add options to the line.
read -r type key _ <"$pubkey" || true
if ! [[ $type =~ ^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521))$ && $key =~ ^[A-Za-z0-9+/]+=*$ ]] ||
	! ssh-keygen -lf "$pubkey" >/dev/null; then
	echo "$pubkey is not an SSH public key" >&2
	exit 1
fi

install -d -m 0755 /etc/beebot-deploy
printf 'BEEBOT_DOMAIN=%q\nBEEBOT_BEHIND_PROXY=%q\nBEEBOT_TRUSTED_PROXIES=%q\n' "$domain" "$behind" "$trusted" \
	>/etc/beebot-deploy/install.env
chmod 0644 /etc/beebot-deploy/install.env
install -m 0755 -o root -g root "$here/beebot-ci-deploy" "$here/beebot-ci-install" /usr/local/sbin/

getent passwd beebot-deploy >/dev/null ||
	useradd --system --user-group --home-dir "$home" --no-create-home --shell /bin/sh beebot-deploy
# No password, but not locked: sshd without PAM refuses even a key to a locked account.
usermod -p '*' beebot-deploy
install -d -o beebot-deploy -g beebot-deploy -m 0700 "$home"
# Root's, so the account can't change its own key's restrictions.
install -d -o root -g root -m 0755 "$home/.ssh"
echo "restrict,command=\"/usr/local/sbin/beebot-ci-deploy\" $type $key beebot-ci" >"$home/.ssh/authorized_keys.new"
chmod 0644 "$home/.ssh/authorized_keys.new"
mv "$home/.ssh/authorized_keys.new" "$home/.ssh/authorized_keys"

file=$home/release.tar.gz
# sudo skips files with a dot in their name, so the draft is never live.
cat >/etc/sudoers.d/.beebot-ci-deploy.new <<EOF
# Written by Bee Bot's ci-deploy-setup.sh: CI's deploy key may install or update from one file, and nothing else.
beebot-deploy ALL=(root) NOPASSWD: /usr/local/sbin/beebot update $file, \\
	/usr/bin/env BEEBOT_UPDATE_FORCE_FAIL\\=1 /usr/local/sbin/beebot update $file, \\
	/usr/local/sbin/beebot-ci-install $file
EOF
visudo -cf /etc/sudoers.d/.beebot-ci-deploy.new >/dev/null
install -m 0440 /etc/sudoers.d/.beebot-ci-deploy.new /etc/sudoers.d/beebot-ci-deploy
rm -f /etc/sudoers.d/.beebot-ci-deploy.new
echo "CI can deploy as beebot-deploy. DEPLOY_KNOWN_HOSTS: <host> $(cut -d ' ' -f 1,2 /etc/ssh/ssh_host_ed25519_key.pub)"

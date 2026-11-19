# Backups

Nightly encrypted backups of a Bee Bot host with [restic](https://restic.net) (`apt install restic`): it encrypts, deduplicates, prunes and checks, so there is little left to write here. As root:

```sh
deploy/backup/install.sh
```

It installs `restic` and `sqlite3` if they are missing, then `/usr/local/sbin/beebot-backup` and `beebot-backup.timer` (02:30 plus up to 30 minutes, catching up after downtime). It generates the repository key `/etc/beebot-backup/key` (root, 0600) if there is none and creates the repository. Run it again whenever you like: it keeps the key, the config and the repository.

**Copy `/etc/beebot-backup/key` off the host.** Nothing can read a backup without it, and it is never in a backup.

The destination is a local folder by default, `/var/backups/beebot/restic`. Keep it on another disk, or set any restic repository (`sftp:`, `s3:`, `rest:`, ...) and its credentials in `/etc/beebot-backup/backup.env`.

## What each run does

1. Takes a consistent copy of every SQLite database with `VACUUM INTO`, as the database's owner: the gateway's `gateway.db` and each cell's `data/beebot.db`. The live files are never copied.
2. Backs up those copies, each cell's `data/` (workspaces, rooms and attachments, memory, skills), `/etc/beebot` and the cells' drop-ins: each slice's quota and each unit's box cap and budget (`beebotd@<cell>.service.d/limits.conf`). A cell whose database can't be copied is left out of that snapshot and named in the log; the others are still backed up, and the unit fails at the end.
3. Keeps 7 daily and 4 weekly snapshots and prunes the rest.
4. Verifies: `restic check` reads back 10% of the data (`BEEBOT_BACKUP_CHECK_SUBSET`), then the databases are restored from the newest snapshot into a temp folder and must pass `PRAGMA integrity_check`. If anything fails, the unit fails. See it with `systemctl status beebot-backup` and `journalctl -u beebot-backup`.

Never backed up:

- Claude and Codex logins: every account's `CLAUDE_CONFIG_DIR` (`data/credentials/`), and any `.credentials.json` anywhere. After a restore onto a new host, each user signs in again.
- `data/runtime/`, rebuilt by beebotd, and folders marked as caches (`CACHEDIR.TAG`).
- Each cell's Podman storage and caches, which live outside `data/`. The box image is loaded again when a cell starts.

## Vault keys

`/etc/beebot/creds/<cell>.vault-key.cred` is backed up. These are sealed with `systemd-creds`, with a key that belongs to this host (`/var/lib/systemd/credential.secret`, and the TPM when there is one), which is not backed up. So:

- Restoring onto the **same host** brings back every vault.
- On a **new host** the sealed keys can't be opened, so the secrets in each cell's vault (API keys, connector tokens) are lost. Everything else comes back. To move vaults too, migrate the cells' keys yourself while the old host still runs: decrypt each cred there with `systemd-creds decrypt` and encrypt it again on the new host, before you start its cell.

## Restore

`beebot-backup restore` stops the units it affects (a cell's socket with its service, so the gateway can't start it mid-restore), puts the data back and starts again whatever it stopped. A cell's current `data/` is moved aside to `data.before-restore-<time>`, not deleted, and its logins are carried over. If a restore fails, the units stay stopped.

```sh
restic snapshots                         # with RESTIC_REPOSITORY and RESTIC_PASSWORD_FILE set
beebot-backup restore bb0123456789        # one cell, from the newest snapshot
beebot-backup restore bb0123456789 4bd1e2f0   # one cell, from that snapshot
beebot-backup restore all                 # config, gateway database, every cell
```

A cell that no longer exists on the host: run `beebot-backup restore <cell>` once to bring back its vault key, then `beebot-provision user add <cell>` (it keeps that key), then the restore again.

On a new host:

1. Install the release with `deploy/install.sh` (it runs `deploy/backup/install.sh` too).
2. Put the old key in `/etc/beebot-backup/key` and the old `backup.env` in place. Point it at the old repository, not at a new empty one.
3. `beebot-backup restore all`. This overwrites `/etc/beebot` with the backed-up one.
4. For each cell it reports missing: `beebot-provision user add <cell>`, then `beebot-backup restore <cell>`.
5. Users sign in to their Claude and Codex accounts again, and enter vault secrets again unless you moved the keys.

## Testing

`deploy/backup/selftest.sh`, as root on Linux with restic and sqlite3, runs all of this against a fake host in a temp folder. A cell's database is being written all through the backup. It checks that no login is in the backup, restores a cell and everything, and shows a damaged repository failing verification.

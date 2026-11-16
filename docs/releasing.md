# Releasing

Installers are built by `.github/workflows/release.yml` and published to the public
[teamblinto/bee-bot-releases](https://github.com/teamblinto/bee-bot-releases) repo, which the app's
auto-updater reads anonymously. This repo stays private.

## Cutting a release

1. Bump `version` in `apps/desktop/package.json` and merge it to `main`.
2. Tag that commit and push the tag: `git tag v0.2.0 && git push origin v0.2.0`.
3. The workflow checks the tag matches the version, runs the checks, creates a draft release,
   builds Windows, macOS and Linux into it, then publishes it. Clients see nothing until every
   platform has uploaded.
4. Edit the release notes on bee-bot-releases if you want more than the generic line. Never paste
   private details there: the repo is public.

A failed build leaves the draft in place. Re-run the failed jobs; uploads overwrite files in the
draft. A tag whose release is already published fails, so bump the version instead.

## One-time setup

Create a GitHub Environment named `release` in this repo, limited to tags matching `v*.*.*`. Put
every secret below in it. Adding required reviewers means approving each stage (prepare, build,
publish) of every release.

| Secret           | Value                                                                               |
| ---------------- | ----------------------------------------------------------------------------------- |
| `RELEASES_TOKEN` | Fine-grained PAT, repository access bee-bot-releases only, Contents: read and write |

Optional signing. Builds succeed unsigned without them.

| Secret                                                      | Value                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------- |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | Entra app allowed to sign with Azure Trusted Signing          |
| `AZURE_TRUSTED_SIGNING_ENDPOINT`                            | e.g. `https://eus.codesigning.azure.net`                      |
| `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`                        | Trusted Signing account                                       |
| `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`            | Certificate profile                                           |
| `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`                      | Subject CN of the certificate, exactly                        |
| `CSC_LINK`, `CSC_KEY_PASSWORD`                              | Base64 Developer ID Application `.p12` and its password       |
| `APPLE_API_KEY`                                             | Contents of the App Store Connect `.p8` key, for notarization |
| `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`                      | That key's ID and issuer ID                                   |

Unsigned macOS builds cannot auto-update, and unsigned Windows installers show a SmartScreen
warning.

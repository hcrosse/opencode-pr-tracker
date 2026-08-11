# Releasing

## Policy

The package follows SemVer and supports OpenCode `>=1.18.15 <2`. Release Please
uses Conventional Commit pull request titles. Before 1.0, features and breaking
changes increment the minor version, while fixes and performance changes
increment the patch version.

## Repository Setup

Use `main` as the default branch, allow squash merges only, use the pull request
title as the squash commit title, and enable immutable releases. Keep `Build`,
`CodeQL`, `Format`, `Lint`, `OpenCode smoke`, `Test`, and `Workflow security` as
required contexts. Add `Package` and `Conventional title` only after both new
workflows have completed successfully. Keep the CodeQL code-scanning rule.

Create a GitHub App installed only on `hcrosse/opencode-pr-tracker`. Disable
webhooks and grant read/write access to Contents, Issues, and Pull requests. Add
its client ID as the Actions variable `APP_CLIENT_ID` and its complete private
key PEM as the Actions secret `APP_PRIVATE_KEY`. The `release` job exchanges
these values for the short-lived token used by Release Please, which allows the
release pull request to start normal required checks.

## npm Bootstrap

Trusted publishing requires an existing package. From a clean checkout, run
`bun ci`, confirm `npm whoami` can publish under `@hcrosse`, then publish `0.0.0`
under the non-default `bootstrap` tag:

```sh
(
  set -eu
  artifact_dir="$(mktemp -d)"
  trap 'git restore package.json; rm -rf "$artifact_dir"' EXIT
  npm version 0.0.0 --no-git-tag-version
  bun run build
  npm pack --ignore-scripts --pack-destination "$artifact_dir"
  set -- "$artifact_dir"/*.tgz
  test "$#" -eq 1
  artifact_path="$1"
  test -f "$artifact_path"
  git restore package.json
  npm publish "$artifact_path" --access public --tag bootstrap --ignore-scripts
  npm deprecate @hcrosse/opencode-pr-tracker@0.0.0 "Bootstrap release; use latest"
  rm -rf "$artifact_dir"
  trap - EXIT
)
```

Do not publish `0.0.0` to `latest`. The first automated release is `0.1.0`.

## Trusted Publisher

Configure the npm trusted publisher for `@hcrosse/opencode-pr-tracker` with:

- Organization or user: `hcrosse`
- Repository: `opencode-pr-tracker`
- Workflow filename: `release.yml`
- Environment: unset
- Allowed action: `npm publish`

Do not configure `NPM_TOKEN`. The `package` job checks out the exact release tag,
installs dependencies, runs `bun run check`, builds one npm tarball, records its
SHA-256, and uploads that file without an archive wrapper. Only the `publish` job
has `id-token: write`; it downloads the artifact by ID, verifies that exactly one
tarball matches the recorded digest, and publishes that path with lifecycle
scripts disabled. It does not check out or execute repository code.

## Flow

Each push to `main` lets Release Please open or update a release pull request.
Review its version and changelog, wait for required checks, and squash-merge it.
The next run creates the immutable tag and GitHub release, then runs the package
and npm trusted-publishing jobs described above.

## Recovery

After an npm registry or OIDC failure, first check the published versions:

```sh
npm view @hcrosse/opencode-pr-tracker versions --json
```

If the version is absent, use **Re-run failed jobs** so the publish job consumes
the existing package artifact. Do not re-run the entire workflow because Release
Please may return `release_created=false`. If the version exists, do not publish
again. A package, build, test, or digest failure requires a fix on `main` and a
new version. Never move a release tag, overwrite an npm version, or reuse a
version.

# Releasing

## Release Policy

This package follows SemVer and supports OpenCode `>=1.18.15 <2`. Release
Please determines the next version from the pull request titles documented in
[CONTRIBUTING.md](../CONTRIBUTING.md). Before 1.0, features and breaking changes
both increment the minor version; fixes and performance changes increment the
patch version.

## Repository Setup

Set `main` as the default branch. Allow squash merges only, use the pull request
title as the squash commit title, and use the pull request body as the commit
message:

```sh
gh api --method PATCH repos/hcrosse/opencode-pr-tracker \
  -f default_branch=main \
  -F allow_merge_commit=false \
  -F allow_rebase_merge=false \
  -F allow_squash_merge=true \
  -f squash_merge_commit_title=PR_TITLE \
  -f squash_merge_commit_message=PR_BODY
```

Enable immutable releases in the repository settings. For the `main` branch
ruleset, retain the existing required status contexts `Build`, `CodeQL`,
`Format`, `Lint`, `OpenCode smoke`, `Test`, and `Workflow security`. After the new
workflows have run successfully, add `Package` and `Conventional title` as
required status contexts.
Separately, retain the CodeQL code-scanning rule.

### GitHub App

Create a GitHub App for this release workflow and install it on
`hcrosse/opencode-pr-tracker`:

1. Open the GitHub App settings for the `hcrosse` account and create a new App.
2. Disable webhooks because this workflow does not use them.
3. Grant repository permissions for Contents, Issues, and Pull requests, each
   with read and write access.
4. Install the App for `hcrosse/opencode-pr-tracker` only.
5. Generate a private key and retain the complete PEM file.
6. In the repository Actions settings, create variable `APP_CLIENT_ID` with the
   App's client ID and secret `APP_PRIVATE_KEY` with the complete PEM contents.

The `release` job in `.github/workflows/release.yml` exchanges these credentials
for a short-lived installation token. Release Please uses that token to create
and update its pull request. Unlike changes made with the workflow's default
`GITHUB_TOKEN`, those pull request events start the required checks.

### npm Bootstrap

Publish `0.0.0` once under the non-default `bootstrap` tag so npm creates the
package before trusted publishing is configured. From a clean checkout, run
`bun ci` and confirm `npm whoami` reports an account allowed to publish under
the `@hcrosse` scope. Then run these commands. They build and validate one real
tarball, publish that exact file without lifecycle scripts, and restore the
manifest even if publication fails:

```sh
(
  set -eu
  npm version 0.0.0 --no-git-tag-version
  artifact_dir="$(mktemp -d)"
  trap 'rm -rf "$artifact_dir"; git restore package.json' EXIT
  bun run build
  package_output="$(bun ./scripts/check-package.ts --output-directory "$artifact_dir")"
  artifact_path="${package_output#PACKAGE_PATH=}"
  test "$package_output" = "PACKAGE_PATH=$artifact_path"
  npm publish "$artifact_path" --access public --tag bootstrap --ignore-scripts
  npm deprecate @hcrosse/opencode-pr-tracker@0.0.0 "Bootstrap release; use latest"
)
```

Do not publish `0.0.0` to `latest`. The first automated release is `0.1.0`.

### npm Trusted Publisher

In the npm settings for `@hcrosse/opencode-pr-tracker`, add a GitHub Actions
trusted publisher with these coordinates:

- Organization or user: `hcrosse`
- Repository: `opencode-pr-tracker`
- Workflow filename: `release.yml`
- Environment: leave unset
- Allowed action: `npm publish`

Trusted publishing is separate from the GitHub App. The `publish` job receives
`id-token: write`, exchanges the GitHub OIDC identity for npm credentials, and
publishes with provenance. The repository must not define or pass an
`NPM_TOKEN`.

## Release Flow

Each push to `main` runs `.github/workflows/release.yml`. Release Please opens or
updates a release pull request, and the GitHub App token allows its normal pull
request checks to run. Review the version and changelog, wait for required
checks, then squash-merge the pull request.

The merge runs the workflow again. Release Please creates the immutable tag and
GitHub release. The `publish` job checks out that exact tag, runs the quality
checks, builds and validates one real tarball, then publishes that same file
through npm OIDC with lifecycle scripts disabled.

## Recovery

Retry only a transient npm registry or OIDC failure from the `Publish package`
step. First check whether npm already has the version:

```sh
npm view @hcrosse/opencode-pr-tracker versions --json
```

If the version is absent, use GitHub Actions **Re-run failed jobs** for the
failed `publish` job. Do not re-run the entire workflow because Release Please
may then report `release_created=false` and skip publication. If npm has the
version, treat publication as complete and repair any remaining metadata
without publishing again.

Do not retry an immutable release tag after a build, test, or package check
fails. Fix the failure on `main` and release a new version. Never move a release
tag, overwrite an npm version, or reuse a version.

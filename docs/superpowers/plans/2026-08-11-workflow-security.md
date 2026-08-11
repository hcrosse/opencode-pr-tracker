# Workflow Security Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Block invalid or unsafe GitHub Actions changes while enforcing a
seven-day package release-age gate.

**Architecture:** Keep ordinary CI read-only and add a dedicated
`pull_request_target` workflow whose executable definition comes from `main`.
The trusted workflow fetches only candidate workflow blobs through GitHub's API,
scans them without a write token, and delegates commit-status publication to a
separate job with only `statuses: write`.

**Tech Stack:** GitHub Actions, Python 3, GitHub CLI, actionlint 1.7.12, zizmor
1.29.0, Bun 1.3.14

## Global Constraints

- Work only in `.worktrees/workflow-security` on branch
  `chore/workflow-security`.
- Keep GitHub CodeQL Default Setup unchanged.
- Do not add Poutine, ghalint, pinact, Super-Linter, ShellCheck,
  dependency-update automation, or automerge.
- Pin every GitHub Action to a full commit SHA and every downloaded executable
  to an exact version and checksum.
- The repository owner reviews scanner and action pins quarterly and
  immediately on relevant security advisories; updates remain manual.
- Before granting any additional write collaborator access, move status
  provenance to a dedicated GitHub App or organization-level required workflow.
- Do not update the repository ruleset until the trusted workflow is present on
  `main` and has posted a successful `Workflow security` status on a subsequent
  pull request.
- Do not commit, push, create a pull request, or mutate GitHub settings without
  explicit user approval.

## Task 1: Implement the Local Policy

**Files:**

- Modify: `bunfig.toml`
- Modify: `.github/workflows/ci.yml`
- Create: `.github/workflows/workflow-security.yml`

**Interfaces:**

- Consumes the existing ordinary CI triggers, the immutable pull request head
  SHA, and GitHub tree/blob APIs.
- Produces a seven-day Bun package gate and, after bootstrap, a fixed
  `Workflow security` commit status.

- [x] Set `minimumReleaseAge = 604800` in `bunfig.toml`.
- [x] Set `persist-credentials: false` on the existing CI checkout.
- [x] Remove the PR-defined security job from `.github/workflows/ci.yml`.
- [x] Add `.github/workflows/workflow-security.yml` with
  `pull_request_target` events for `edited`, `opened`, `reopened`, and
  `synchronize`, restricted to base branch `main`, plus workflow-level
  `permissions: {}`.
- [x] Serialize trusted runs per base-repository pull request with concurrency
  group `workflow-security-${{ github.event.pull_request.number }}` and
  `cancel-in-progress: false`.
- [x] Require
  `github.repository == 'hcrosse/opencode-pr-tracker'` on all three trusted jobs,
  retaining `always()` on the final reporter.
- [x] Add a first `Set workflow security pending` job with only
  `statuses: write`, a five-minute timeout, no checkout or download, and a fixed
  pending `Workflow security` status linked to the current run.
- [x] Publish fixed status descriptions for trusted pending, success, and
  failure outcomes while retaining the run URL as target.
- [x] Add a `Scan workflows` job with only `contents: read`, a ten-minute
  timeout, no checkout, and a dependency on the pending-status job.
- [x] Pass the event base ref and repository default branch through trusted
  step-scoped environment values and require both to equal `main`.
- [x] Fetch only direct regular `.yml` and `.yaml` workflow blobs from the
  validated pull request head repository and lowercase 40-character head SHA.
- [x] Reject truncated trees, invalid directories and SHAs, non-regular
  workflow entries, non-base64 blobs, invalid base64, and empty workflow sets.
- [x] Write candidate files only beneath `candidate/.github/workflows` using
  their basenames.
- [x] Validate the base repository and lowercase 40-character base SHA, fetch
  its workflow tree, and require the candidate validator blob SHA to exactly
  equal the base `workflow-security.yml` blob SHA before writing scanner inputs.
- [x] Fail trusted Python validation unless the parsed base repository is
  exactly `hcrosse/opencode-pr-tracker`.
- [x] Run checksum-verified actionlint 1.7.12 only against candidate workflow
  files with ShellCheck and Pyflakes disabled.
- [x] Run pinned zizmor 1.29.0 against the candidate directory with the regular
  persona, offline audits, a blank token, no Advanced Security upload, and no
  annotations.
- [x] Pass a trusted zizmor configuration that ignores only
  `dangerous-triggers` at `workflow-security.yml:3:1` and leaves every other
  audit and workflow active.
- [x] Add a separate `Report workflow security` job that always follows the
  scan, has only `statuses: write`, performs no checkout or download, and posts
  success only for a successful scan.

The trusted workflow treats pull request YAML only as parser input. A trusted
maintainer remains responsible for reviewing changes to the validator itself.
Organization-level required workflows are not available to this personal
repository.

`hcrosse` is the only write-capable collaborator and trusted administrator.
External fork and Dependabot workflows have read-only tokens and cannot publish
commit statuses. Repository rules administrators remain the policy trust root,
and administrator-authored status spoofing is outside the threat model because
the administrator can directly merge or change settings.

## Task 2: Verify the Local Implementation

Use `/var/folders/p9/4jhsc_7n1lzgb0hp_fny_wb00000gn/T/opencode/actionlint-1.7.12`
as the approved temporary directory for the local actionlint binary.

- [x] Run `bun run check`.
- [x] Download `actionlint_1.7.12_darwin_arm64.tar.gz` to the approved temporary
  directory and verify SHA-256
  `aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f`.
- [x] Extract actionlint and run it with `-shellcheck= -pyflakes=` against all
  workflow files.
- [x] Run
  `ghcr.io/zizmorcore/zizmor:1.29.0@sha256:863026d54f91271b10b60b67ad8054cb37120167e162482597db102b3026a284`
  with `--persona=regular`, `--no-online-audits`, `--color=never`, and a trusted
  global config that ignores only `workflow-security.yml:3:1` for
  `dangerous-triggers`, against `.github/workflows`.
- [x] Run `git diff --check`.
- [x] Inspect final `git status --short` and `git diff` output.
- [x] Run pinned zizmor with the auditor persona and the same targeted config;
  enumerate and document regular-persona suppressions without adding ignores.

The approved `dangerous-triggers` exception is valid only while the candidate
validator blob exactly matches the base validator and remains scoped to
`workflow-security.yml:3:1`. Stop and report any other CodeQL, actionlint, or
zizmor finding.

The final pinned zizmor run reported no findings, one approved ignored finding,
and four findings suppressed by the required regular persona. The auditor
persona identified static matrix command expansion and missing CI concurrency in
`ci.yml`, plus two documented status-write grants in
`workflow-security.yml`. Workflow-level serialization resolved the previous
trusted-workflow concurrency diagnostic. The approved design records why the
remaining low-severity diagnostics are accepted without new ignores.

## Task 3: Publish and Bootstrap the Trusted Workflow

The `pull_request_target` workflow cannot run for the pull request that first
adds it because GitHub reads that event's workflow definition from the default
branch.

- [ ] Obtain explicit approval before committing, pushing, or creating a pull
  request.
- [ ] Publish and merge the bootstrap change while leaving the ruleset
  unchanged.
- [ ] Trigger the trusted workflow on a subsequent pull request.
- [ ] Verify the trusted run completed and posted the exact successful commit
  status context `Workflow security` to the pull request head.

Validator changes require this maintainer-controlled break-glass sequence:

- [ ] Save a recovery snapshot and temporarily remove the required
  `Workflow security` status with the same concurrency and read-back safeguards
  used for ruleset updates.
- [ ] Freeze all unrelated merges and merge-queue activity until the updated
  validator is verified and the required status is restored.
- [ ] Merge a separately reviewed validator update.
- [ ] Verify the updated trusted workflow from `main` on a subsequent pull
  request.
- [ ] Restore the required `Workflow security` status and verify the complete
  ruleset again.

## Task 4: Register the Blocking Check Safely

**External target:** GitHub ruleset `Default branch` (`20700973`)

- [ ] Open an exclusive ruleset maintenance window.
- [ ] Save the full current ruleset response as a recovery snapshot in the
  approved temporary directory.
- [ ] Record the response's `updated_at` value.
- [ ] Build a normalized update payload that appends
  `{"context":"Workflow security","integration_id":15368}` exactly once and
  does not reorder existing rules or required checks.
- [ ] Inspect a structural diff between the current normalized ruleset and the
  prepared payload.
- [ ] Assert the prepared payload contains exactly one `Workflow security`
  required-status-check entry.
- [ ] Re-fetch the ruleset's `updated_at` immediately before PUT and abort if it
  differs from the recorded value. Retain this check because the repository
  endpoint has no conditional-write guarantee relied upon by this plan.
- [ ] PUT the prepared payload to the repository ruleset update endpoint.
- [ ] Read the complete ruleset back and compare it with the recovery snapshot
  and prepared payload.
- [ ] Verify every existing required check and rule remains present and in the
  same order.
- [ ] Verify CodeQL thresholds, enforcement, conditions, and bypass actors are
  unchanged.
- [ ] Verify the only intended structural change is one required
  `Workflow security` status context.

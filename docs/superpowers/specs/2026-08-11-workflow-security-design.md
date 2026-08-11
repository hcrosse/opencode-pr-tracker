# Workflow Security Design

## Goal

Prevent unsafe or invalid GitHub Actions changes from merging without trusting
workflow code from the pull request or adding routine dependency-update pull
requests, automatic merges, or write-capable scanners.

## Package and Checkout Controls

- Set Bun's minimum package release age to seven days (`604800` seconds).
  Dependabot security updates remain immediate and continue to require human
  review.
- Set `persist-credentials: false` on every checkout step. The existing CI jobs
  do not push changes or make authenticated Git requests after checkout.

## Trusted Workflow Architecture

Use a dedicated `.github/workflows/workflow-security.yml` workflow triggered by
`pull_request_target` for pull request creation, editing, reopening, and head
updates, restricted to base branch `main`. GitHub loads this executable workflow
definition from the default branch, so a pull request cannot change the
validator that evaluates the same pull request. Workflow-level permissions are
empty.

Trusted runs are serialized per base-repository pull request with concurrency
group `workflow-security-${{ github.event.pull_request.number }}` and
`cancel-in-progress: false`. Serial execution prevents an older run's final
status from racing a newer run's pending or final status on the same head SHA.
Cancellation is not used because the final reporter intentionally runs with
`always()`; cancelling an older run could otherwise publish a failure after a
newer run starts.

The workflow has three jobs with separate tokens:

- `Set workflow security pending` runs first with only `statuses: write`. It
  does not check out or download content. It posts the fixed `Workflow security`
  context with description `Trusted workflow scan pending` on the pull request
  head and links it to the current run. This resets same-SHA rescans and prevents
  an older pending write from racing after the final result.
- `Scan workflows` has only `contents: read`. It never checks out pull request
  code and depends on the pending-status job. A trusted inline Python program
  validates that the event base ref and repository default branch are both
  exactly `main`, validates the pull request head repository and immutable
  40-character lowercase head SHA, then calls `gh api` to traverse the
  repository's Git trees. It fetches only regular `.yml` and `.yaml` blobs
  directly under `.github/workflows`, rejects truncated trees and non-regular
  workflow entries, requires base64 blob encoding, and fails when no workflow
  files exist. Each blob is written by basename beneath
  `candidate/.github/workflows`. Before writing scanner inputs, the program also
  validates the base repository and immutable base SHA, fetches the base
  workflow tree, and requires the candidate `workflow-security.yml` blob SHA to
  exactly equal the base branch's blob SHA.
- `Report workflow security` always runs after the scan and has only
  `statuses: write`. It does not check out or download content. It posts the
  fixed `Workflow security` commit status to the pull request head, links the
  status to the trusted workflow run, and reports success only when the scan job
  succeeded. Fixed descriptions distinguish `Trusted workflow scan succeeded`
  from `Trusted workflow scan failed`.

All three jobs require
`github.repository == 'hcrosse/opencode-pr-tracker'`, preventing stale workflow
copies in forks from executing. Trusted Python validation independently requires
the parsed base repository to equal `hcrosse/opencode-pr-tracker` before making
GitHub API requests.

Separating these jobs prevents the parser process and scanner actions from ever
receiving a status-writing token. Both status jobs run on fresh runners and
never receive candidate files. Candidate workflow YAML is untrusted parser
input, not executable repository content.

## Scanner Configuration

The scan job downloads actionlint 1.7.12 for Linux AMD64 and verifies SHA-256
`8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8` before
execution. It disables actionlint's optional ShellCheck and Pyflakes integrations
because the runner-provided versions are not controlled by this repository and
scans only the downloaded candidate workflow files.

The job runs zizmor 1.29.0 through `zizmorcore/zizmor-action` pinned to commit
`3dc1ecc9bcb9e94e9b2c709687979e1298497054`. Zizmor uses the regular persona,
scans `candidate/.github/workflows` offline, receives a blank token, and does not
create annotations or upload Advanced Security results. The trusted workflow
writes and explicitly passes a fixed zizmor configuration that ignores only the
`dangerous-triggers` finding at `workflow-security.yml:3:1`. Every other audit
remains active for that file, and `dangerous-triggers` remains active for every
other workflow. The narrow exception is justified because the validator blob
must equal the base branch, candidate YAML is only parser input, and the parser
has no write token, secrets, checkout, cache, artifact, package install, or
repository script.

The repository owner reviews scanner and action pins quarterly and immediately
when a relevant security advisory is published. Updates remain manual and
deliberate. This design does not add automated update pull requests or
automerge.

An auditor-persona diagnostic run enumerates the findings suppressed by the
required regular persona. They remain unignored and accepted as low-severity
diagnostics:

- `template-injection` on `ci.yml` expands only commands from the static,
  repository-defined matrix. No event or pull request value enters the command.
- `concurrency-limits` on `ci.yml` affects read-only validation jobs; concurrent
  runs cannot mutate repository state or publish a security decision.
- Two `undocumented-permissions` findings identify the pending and final
  `statuses: write` grants. Their purpose and isolation are documented in this
  design, and neither job receives candidate files or performs downloads.

No zizmor ignores cover these diagnostics. The only configured ignore remains
the approved location-specific `dangerous-triggers` exception.

## Threat Boundary

The trusted workflow scans a pull request's proposed workflow files. It does not
execute or check out the pull request branch, and it does not recursively fetch
other files. A trusted maintainer remains responsible for reviewing changes to
`.github/workflows/workflow-security.yml` itself before those changes reach the
default branch.

Organization-level required workflows would provide a stronger externally
managed validator, but they are not available to this personal repository. The
default-branch trusted workflow is the available enforcement boundary.

Current collaborator evidence identifies `hcrosse` as the only write-capable
collaborator and trusted administrator. External fork and Dependabot pull
request workflows receive read-only tokens and cannot call the commit-status
API. This is a binding provenance invariant: before granting any additional
collaborator write access, status publication must move to a dedicated GitHub
App or an organization-level required workflow. Repository rules administrators
remain the policy trust root; administrator-authored status spoofing is outside
this threat model because the same administrator can merge or change repository
settings directly.

The blob equality gate makes validator updates fail ordinary pull request
checks. A validator update therefore uses a maintainer-controlled break-glass
sequence: temporarily remove the required `Workflow security` status, merge a
separately reviewed validator change, verify the updated workflow from `main` on
a subsequent pull request, and restore the required status. From removal until
restoration, maintainers freeze every unrelated merge and all merge-queue
activity. Ruleset recovery, exclusive-maintenance, concurrency, structural-diff,
and read-back safeguards apply to both the temporary removal and restoration.

## Existing Controls

Keep GitHub CodeQL Default Setup unchanged. It analyzes Actions and
JavaScript/TypeScript, and the default-branch ruleset already blocks applicable
CodeQL findings. CodeQL remains separate from workflow linting because zizmor
SARIF upload would require `security-events: write` and would weaken the
scanner's direct nonzero-exit blocking behavior.

Do not add Poutine, ghalint, pinact, Super-Linter, or a standalone ShellCheck
job. Their current signal either overlaps CodeQL, actionlint, and zizmor or does
not justify another executable and update stream for this workflow.

## Bootstrap and Merge Protection

The trusted workflow cannot run on the pull request that first adds it because
`pull_request_target` requires the workflow file to exist on the default branch.
Keep the ruleset unchanged while this bootstrap change is reviewed and merged.
After the workflow reaches `main`, trigger it on a subsequent pull request and
confirm that it posts a successful `Workflow security` status. Only then add
that exact context to the existing `Default branch` ruleset.

Perform ruleset updates only in an exclusive maintenance window. Before
mutating the ruleset, save the full response as a recovery snapshot in the
approved temporary directory. Record `updated_at`, build a normalized update
payload that appends the required context exactly once without reordering
existing rules or checks, inspect a structural diff, and assert exactly one
`Workflow security` entry. Re-fetch `updated_at` immediately before the PUT and
abort if it changed. The repository endpoint has no conditional-write guarantee
relied upon by this plan, so the timestamp check and exclusive window are both
required. After the PUT, read the ruleset back and verify all existing checks,
rules, CodeQL thresholds, enforcement, conditions, and bypass actors.

## Verification

- Run the repository's full `bun run check` command.
- Run the pinned actionlint binary against all repository workflow files using
  the same disabled integrations as the trusted workflow.
- Run zizmor 1.29.0 against all repository workflow files with the regular
  persona, offline audits, and the same trusted location-specific exception.
- Run zizmor with a diagnostic persona and the same exception to enumerate the
  findings hidden by the regular persona. Do not add ignores for those findings;
  document their identities and acceptance rationale.
- Run `git diff --check` and inspect the final status and diff for accidental
  permission increases, floating action references, credentials, generated
  files, or unrelated changes.
- After publication, confirm a successful `Workflow security` status on a
  subsequent pull request before changing the ruleset.

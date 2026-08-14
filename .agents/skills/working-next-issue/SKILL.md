---
name: working-next-issue
description: Use when the user asks to move from merged pull requests to an unclaimed issue and carry it through a new attached pull request.
---

# Working Next Issue

Use one issue, one Git-created worktree, and one pull request. Preserve every unrelated branch, worktree, and working-tree change.

## Workflow

1. Call `pr_list` to establish the complete attachment list for the current session. Verify each listed pull request is merged, detach merged pull requests with `pr_detach`, and leave open or uncertain pull requests attached. If listing fails, stop rather than claiming attachments are cleaned up.
2. Fetch the remote default branch without changing the primary checkout. List open issues with comments, assignees, and linked pull requests, then inspect suitable candidates. An issue is claimed if it has a `CLAIMED` comment, an assignee, a linked implementation pull request, or an active issue-specific worktree.
3. Re-read the selected issue immediately before claiming it. If it is still unclaimed, post exactly `CLAIMED`, with no extra text. Re-read it afterward; the earliest claim wins. If another claim won the race, remove or retract only your claim and choose another issue.
4. Set the Herdr session title to one lowercase word derived from the issue, such as `blockers`. If the Herdr title integration is unavailable, report that limitation instead of substituting another title mechanism.
5. Create a new issue-specific worktree from the fetched remote default branch with `git worktree add -b <branch> <path> origin/<default-branch>`. Use Git directly, never Herdr or another workspace manager. Do not reuse, prune, delete, or clean an existing worktree.
6. Work only inside the new worktree. Read repository guidance and the issue, inspect the affected code, follow test-driven development for behavior changes, and make the smallest scoped change.
7. Run focused checks and the repository's required full verification. Inspect `git status`, the diff, and recent log before committing. Stage only intended files, commit without amending, and push the issue branch.
8. Create a non-draft pull request using the repository template. Include `Closes #<issue>` and only verified checks. Obtain its canonical `https://github.com/<owner>/<repository>/pull/<number>` URL and attach it with `pr_attach`.
9. After creating the pull request and before any merge, arrange manual verification of user-visible OpenCode behavior. Ask permission before changing any OpenCode config. If permission is denied, make no config changes and ask the user to perform another check that exercises the changed behavior or explicitly waive manual verification; wait for the result or waiver and record that no restoration was required. If approved, record the exact contents or absence of every config file that will be touched, build the issue worktree, inspect global and project plugin registrations, and temporarily replace conflicting entries so exactly one issue-worktree plugin resolves. Never append a second copy of the same plugin.
10. When config was changed, prompt the user to quit and reopen the same session, then wait for confirmation that the change works as intended. Whether verification passes or fails, restore every touched config file to its exact previous state before continuing. Confirm the previous plugin path resolves if one existed; otherwise confirm the previous registration remains absent. If verification fails, return to implementation and repeat the checks, pull request update, and manual verification only after restoration. If the change cannot be exercised through OpenCode, explain why and ask the user to approve a specific alternative check that exercises the changed behavior, then wait for and record its outcome, or ask the user to explicitly waive manual verification. Report behavior as unverified when waived. Do not report completion without the user's verification or waiver and successful config restoration or confirmed no-mutation outcome.
11. Report the issue, worktree, automated verification, manual verification method and outcome or waiver, config restoration or no-mutation outcome, and attached pull request. Do not merge, enable auto-merge, or remove the worktree unless the user separately requests it.

## Stop Conditions

- No suitable unclaimed issue exists.
- The attached pull request list cannot be established.
- A claim race cannot be resolved safely.
- The selected issue lacks enough information to define correct behavior.
- Required verification cannot run and the remaining risk is material.
- Previous OpenCode config cannot be restored or its resolution cannot be verified.

Ask one focused question only when a stop condition prevents progress. Routine claims, Git worktree creation, pushes, and pull request creation are already part of this explicitly requested workflow.

# Behavior inventory

This inventory lists the user-visible behaviors of the V1 plugin (0.3.x) that the V2 rewrite keeps. It was extracted from the V1 test suite before that suite was removed. V1 tests were implementation-shaped, so this list records outcomes rather than test code. Dropped features (plugin update checks, the `pr_feedback` tool and V1 file state) are not listed.

Each item names the V2 module that owns it.

## Pull request references (`domain/PullRequest`)

- Accepts `https://github.com/<owner>/<repository>/pull/<n>` and the same URL without `https://`.
- Rejects other hosts, credentials, ports, query strings, fragments, backslashes, whitespace, dot segments, extra path segments and non-positive or unsafe numbers.
- Owner and repository names are canonicalized to lowercase. References that differ only by case identify the same pull request.
- Parsing a canonical URL returns the same URL.

## Attachments per session (`domain/Tracking`, `application/Tracker`)

- A session tracks at most 20 pull requests.
- Attaching an already attached pull request succeeds without duplicating it.
- Attaching any member of a GitHub Stack attaches the whole Stack in bottom-to-top order.
  - A Stack is inserted at the position of its earliest already-attached member. Other attachments keep their order.
  - When refreshes later report a changed Stack, such as pull requests linked into it after they were attached, its attached members are regrouped the same way. The order is saved only when it changes, and only once every attached member agrees on the Stack and no other Stack claims any of them.
  - Existing members keep their original attachment time.
  - Attaching fails without changing state when the Stack cannot be discovered, when the pull request is missing or inaccessible, or when the result would exceed 20.
- Attachments to one session happen in the order they were requested. Different sessions don't block each other.
- Attaching by number resolves the current repository with `gh repo view` in the session's directory. If that fails, the error suggests attaching with a full URL.
- Detaching a pull request that isn't attached reports that without failing.
- Detaching a Stack member removes only that member.
- Detaching by number works when exactly one attachment has that number. When several match, the error lists them and asks for a URL.
- Deleting a session removes its attachments. Corrupt stored state is reported, not silently discarded.

## Status (`domain/Snapshot`, `adapters/github`)

- States: open, merged, closed. An open pull request has CI (passed, pending, failed, none), draft, mergeability (mergeable, conflicting, unknown) and behind.
- CI uses only the newest check run per check identity and the newest status context per context name.
  - Check identity: app, workflow, event and name. Checks without an app fall back to the check suite.
  - Status context names are compared case-insensitively.
  - Checks tied for newest are all kept.
  - Every non-completed check run status counts as pending.
- A null status rollup means no checks.
- "Behind" appears only when GitHub reports `mergeStateStatus: BEHIND`, which requires a strict up-to-date policy on the base.
- A missing or inaccessible pull request is reported per item. Other items in the batch still succeed.
- GraphQL partial errors affect only their own item.
- Failures are classified as: GitHub CLI missing, authentication required, GitHub unavailable, pull request not found, and invalid response. Diagnostics never include credentials.
- One request covers up to 20 pull requests. Incomplete check pages are fetched until complete. When GitHub reports only part of a Stack (more than 100 members, or an unreadable member), attaching fails and changes nothing; V1 fetched further Stack pages.

## Refresh (`domain/RefreshPolicy`, `application/Monitor`)

- Open and closed pull requests refresh. Closed pull requests keep refreshing so a reopen is noticed. Merged pull requests stop refreshing.
- One batch covers every due pull request, and a pull request attached in several sessions is fetched once.
- A manual sync reports its outcome. Refresh requests made during a running refresh join a single trailing refresh.
- After a failed refresh, the last good status stays and is marked stale with a diagnostic. After 5 minutes of continuous failure it becomes unavailable. The next success clears the diagnostic.
- Detached pull requests leave the cache.
- Stopping the plugin cancels in-flight requests and publishes nothing afterwards.

## Sidebar (`domain/StackLayout`, `ui/`)

- Every attached pull request appears once, with repository, number, title and status.
- Appearance precedence:
  1. Merged: purple, strikethrough.
  2. Closed: red, strikethrough.
  3. Conflict: red. Conflict takes precedence over draft and CI.
  4. Failed CI: red.
  5. Draft: gray. Draft takes precedence over behind, and over pending CI.
  6. Pending CI: yellow.
  7. Behind: yellow.
  8. Passed: green.
  9. No checks, or unavailable: gray.

  CI is used while GitHub is still computing mergeability.

- Stale status is shown as a separate soft-failure marker.
- Stacks:
  - Stack members appear together in Stack order with `┌─`, `├─` and `└─` markers.
  - Internal gaps show `├┄ N PR(s) not attached`. Missing members outside the attached range use open boundary markers, not extra rows.
  - A single attached member of a larger Stack uses an incomplete marker.
  - Separate Stacks, including Stacks in one repository, stay separate.
  - Standalone pull requests, and members whose membership is unknown, use `•`.
- Compact layout shows one row per pull request, plus internal gaps, without titles.
- With more than two pull requests, the heading collapses and expands the list. Refreshes continue while it's collapsed.
- Clicking a row opens the pull request on macOS and Linux. Gap rows aren't clickable. Unsupported platforms and browser failures produce messages.
- Wrapped titles keep their Stack connectors and alignment.

## Commands and tools (`tui.tsx`, `server.ts`)

- Slash commands: `/pr-attach`, `/pr-open`, `/pr-detach`, `/pr-sync`. Without a session they warn. With no attachments, `/pr-open` and `/pr-detach` report that.
- Agent tools: list, attach and detach, scoped to the calling session.
  - List returns canonical URLs in attachment order.
  - Detach accepts a URL or a positive safe integer.
  - Invalid input returns a structured tool error.
- Dialogs close when the plugin unloads.

## Repository process (unchanged)

- Pull request titles must follow Conventional Commits (`scripts/check-pr-title.ts`).
- Issue claim commands `CLAIM`, `UNCLAIM` and `CLEAR` (`.github/scripts/issue-claim.mjs`, `test/repository/issue-claim.test.ts`).

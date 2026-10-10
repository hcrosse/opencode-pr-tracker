# Behavior inventory

This inventory lists the user-visible behaviors of the V1 plugin (0.3.x) that the V2 rewrite keeps. It was extracted from the V1 test suite before that suite was removed. V1 tests were implementation-shaped, so this list records outcomes rather than test code. Dropped features (plugin update checks, the `pr_feedback` tool and V1 file state) are not listed.

Each item names the V2 module that owns it.

## Pull request references (`domain/PullRequest`)

- Accepts `https://github.com/<owner>/<repository>/pull/<n>` and the same URL without `https://`.
- Rejects other hosts, credentials, ports, query strings, fragments, backslashes, whitespace, dot segments, extra path segments and non-positive or unsafe numbers.
- Owner and repository names are canonicalized to lowercase. References that differ only by case identify the same pull request.
- Parsing a canonical URL returns the same URL.

## Attachments per session (`domain/Tracking`, `application/Tracker`)

- A session tracks at most 40 pull requests.
- Attaching an already attached pull request succeeds without duplicating it.
- Attaching any member of a GitHub Stack also attaches the Stack's open members, including drafts, in bottom-to-top order. Merged and closed members are left out unless they are the one named, and nothing already attached is detached.
  - A Stack is inserted at the position of its earliest already-attached member. Other attachments keep their order.
  - When refreshes later report a changed Stack, such as pull requests linked into it after they were attached, its attached members are regrouped the same way. The order is saved only when it changes, and only once every attached member agrees on the Stack and no other Stack claims any of them.
  - Merged pull requests stop refreshing, so when a Stack member reports a changed Stack, attached merged members whose known membership contradicts it are refreshed once. This lets a Stack with a merged member regroup after a link or unlink.
  - Existing members keep their original attachment time.
  - Attaching fails without changing state when the Stack cannot be discovered, when the pull request is missing or inaccessible, or when the result would exceed 40.
- Attachments to one session happen in the order they were requested. Different sessions don't block each other.
- Attaching by number resolves the current repository with `gh repo view` in the session's directory. If that fails, the error suggests attaching with a full URL.
- Detaching a pull request that isn't attached reports that without failing.
- Detaching a Stack member removes only that member.
- Detaching by number works when exactly one attachment has that number. When several match, the error lists them and asks for a URL.
- Deleting a session removes its attachments. Corrupt stored state is reported, not silently discarded.

## Status (`domain/Snapshot`, `adapters/github`)

- States: open, merged, closed. An open pull request has CI (passed, pending, failed, none, unknown), draft, mergeability (mergeable, conflicting, unknown) and behind (yes, no, unknown).
- An enumeration value GitHub adds later reads as unknown: a check run status or conclusion, a status context state, or a merge state status. A completed check run without a conclusion is unknown too. An unrecognized status or conclusion makes a check run unknown whatever its other field says. Unknown CI beats pending and passed; failed beats unknown. Unknown CI refreshes every 15 seconds, like pending CI, since a check in a new status may still be running. Each such value is logged with the value GitHub sent, once per plugin instance, for up to 20 values per field.
- A terminal from an earlier plugin version, reading a newer server, shows unknown CI as pending, an unknown merge state as not behind and an unknown decision as none, and leaves unknown threads out of its counts, as it did before unknown states existed.
- A check timestamp that is not a valid UTC date and time, such as `2026-02-30T08:00:00Z` or a date alone, makes the pull request's answer invalid, rather than ordering the check as the oldest or as another day.
- CI uses only the newest check runs per check identity and the newest status context per context name.
  - A workflow's jobs share one identity: app, workflow and event. The newest run and attempt replaces every job of older runs, including jobs it no longer has.
  - Other check runs are identified by app and name. Checks without an app fall back to the check suite.
  - Status context names are compared case-insensitively.
  - Checks tied for newest are all kept.
  - Every known non-completed check run status counts as pending.
- A null status rollup means no checks.
- With the `reviews` option set to `"all"`, an open pull request, drafts included, also has a review state (`domain/Review`): a decision and counts of unresolved review threads. Merged and closed pull requests have none. The option is `"off"` by default; then the query asks for no review fields and snapshots carry no review state, even when a response has review fields. An absent `reviews` or `layout` option takes its default. A value outside an option's allowed values, or any other option key, fails plugin startup with one `InvalidOptions` error that names every problem: each invalid value with its option and allowed values, and each unknown key with the known options (`server/Options`).
  - The decision is GitHub's `reviewDecision` (approved, changes requested, review required). When that is null, it is derived from writers' latest opinionated reviews: any change request, else any approval, else none. Review required is never derived. A decision or review state GitHub adds later reads as unknown; a derived decision is unknown when no writer requests changes and any writer's review is in an unknown state. Up to 100 writers' reviews are fetched; when there are more, the decision is GitHub's own, or none when GitHub reports none, and is never derived.
  - An approval, reported or derived, is a stale approval when no approving review is of the head commit. This is not checked when some writers' reviews were not fetched.
  - Only unresolved threads count, outdated ones included. A thread is replied when its latest submitted comment, among its last 5, is by the pull request author; otherwise, including ghost authors and threads with only pending comments, it is unreplied. It is unknown when a comment in a state GitHub added later comes after every submitted one.
  - Only the first 20 threads are fetched. When there are more, the counts are lower bounds.
- "Behind" appears only when GitHub reports `mergeStateStatus: BEHIND`, which requires a strict up-to-date policy on the base.
- A missing or inaccessible pull request is reported per item. Other items in the batch still succeed. A pull request GitHub answers as null, or with its own not-found or forbidden error, is missing; an answer that leaves the pull request out is an invalid response.
- GraphQL partial errors affect only their own item.
- Failures are classified as: GitHub CLI missing, authentication required, GitHub unavailable, pull request not found, and invalid response. Diagnostics never include credentials.
- A 2xx body that parses as a GraphQL answer is used whatever its Content-Type. The Content-Type decides only how a body that does not parse is read: one that could not be read, is empty, or is labelled as JSON was cut off (see Refresh); a complete, non-empty body not labelled as JSON, such as a proxy's HTML page, is an invalid response and is not treated as a timeout. JSON with neither `data` nor errors, such as `{}`, is an invalid response too.
- One request covers up to 5 pull requests, sent one request at a time. Incomplete check pages are fetched until complete. When GitHub reports only part of a Stack (more than 100 members, or an unreadable member), attaching fails and changes nothing; V1 fetched further Stack pages.

## Refresh (`domain/RefreshPolicy`, `application/Monitor`)

- Open and closed pull requests refresh. Closed pull requests keep refreshing so a reopen is noticed. Merged pull requests stop refreshing once a refresh succeeds, except for one refresh when a changed Stack report contradicts their membership (see Attaching). A failed refresh is retried.
- One refresh fetches every due pull request, and a pull request attached in several sessions is fetched once.
- A manual sync reports its outcome. Refresh requests made during a running refresh join a single trailing refresh.
- After a failed refresh, the last good status stays and is marked stale with a diagnostic. After 5 minutes of continuous failure it becomes unavailable. The next success clears the diagnostic.
- A rate limit (429, a 403 rate limit, or GraphQL `RATE_LIMITED`) stops every GitHub request from every plugin instance for a while: GitHub's `retry-after` if given, else its reset time once the remaining budget is spent (at most an hour away), otherwise 1 minute, doubling up to 15 until a request succeeds.
- A query GitHub could not finish in time (502, 504, or a 2xx answer whose body could not be read, is empty, or is labelled as JSON but does not parse) shows "GitHub unavailable" and stops that refresh: its remaining requests are not sent. It pauses nothing else. A page of checks that times out fails only its pull request, and the refresh goes on.
- The pull requests in a timed-out query or check page become suspects. Suspects are sent last, one per request, until GitHub answers for them without a timeout or server error, even to say one is missing; one that times out again goes behind the other suspects. Among the other due pull requests, those that failed most go first.
- A pull request whose refresh failed in a way that cost GitHub work (a timeout, another server error, or being left unsent after a timeout) waits 15 seconds before its next refresh, doubling with each such failure up to 15 minutes. Other failures, such as rate limits or no connection, retry after 15 seconds and leave the count of such failures unchanged, so the next one continues the doubling. A success resets the count.
- Detached pull requests leave the cache.
- Stopping the plugin cancels in-flight requests and publishes nothing afterwards.

## Sidebar (`domain/StackLayout`, `ui/`)

- Every attached pull request appears once, with repository, number, title and status.
- Appearance precedence:
  1. Merged: purple, strikethrough.
  2. Closed: red, strikethrough.
  3. Conflict: red. Conflict takes precedence over draft and CI.
  4. Failed CI: red.
  5. Draft: gray. Draft takes precedence over behind, and over unknown or pending CI.
  6. Checks unknown: gray.
  7. Pending CI: yellow.
  8. Merge state unknown: gray.
  9. Behind: yellow.
  10. Passed: green.
  11. No checks, or unavailable: gray.

  CI is used while GitHub is still computing mergeability.

- Stale status is shown as a separate soft-failure marker.
- When review state is on, it follows the status on the first line, each part after a muted `·` and before the stale marker: `approved` (green), `stale approval` (yellow), `changes` (yellow) or `review` (gray), then `N unreplied` (yellow) and `N replied` (gray). Zero counts and no decision are omitted. Lower bounds show as `N+`, or `20+ threads` when none of the first 20 threads is unresolved. Review state never changes the status color. A stale status keeps its last review state.
- Stacks:
  - Stack members appear together in Stack order with `┌─`, `├─` and `└─` markers.
  - Internal gaps show `├┄ N PR(s) not attached`. Missing members outside the attached range use open boundary markers, not extra rows.
  - A single attached member of a larger Stack uses an incomplete marker.
  - Separate Stacks, including Stacks in one repository, stay separate. Where two Stacks touch, an edge that would otherwise look like it continues into the other Stack closes with `╭─` or `╰─`, or `╶─` for a Stack's only attached member.
  - Standalone pull requests, and members whose membership is unknown, use `•`.
- The default compact layout shows one row per pull request, plus internal gaps, without titles. The `full` layout adds each title.
- With more than two pull requests, the heading collapses and expands the list. Refreshes continue while it's collapsed.
- Clicking a row opens the pull request on macOS and Linux. Gap rows aren't clickable. Unsupported platforms and browser failures produce messages.
- Wrapped titles keep their Stack connectors and alignment.

## Commands and tools (`tui.tsx`, `server.ts`)

- Slash commands: `/pr-attach`, `/pr-open`, `/pr-detach`, `/pr-sync`. Without a session they warn. With no attachments, `/pr-open` and `/pr-detach` report that.
- Agent tools: list, attach and detach, scoped to the calling session.
  - List returns canonical URLs in attachment order, each with its status and, when review state is on, its review state, such as `- https://github.com/acme/api/pull/13 (pending; changes requested; 2 unreplied, 1 replied review threads)`. It fetches statuses that are not yet known, as after the plugin restarts, before answering. The sidebar shows a pull request as `loading` until its first fetch.
  - Detach accepts a URL or a positive safe integer.
  - Invalid input returns a structured tool error.
- Dialogs close when the plugin unloads.

## Repository process (unchanged)

- Pull request titles must follow Conventional Commits (`scripts/check-pr-title.ts`).
- Issue claim commands `CLAIM`, `UNCLAIM` and `CLEAR` (`.github/scripts/issue-claim.mjs`, `test/repository/issue-claim.test.ts`).

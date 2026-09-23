# Terminal UI verification map

This directory holds the recipes for verifying what a user sees and does in the pull request sidebar. Read this index, then follow the matching feature file.

## Baseline preconditions

- A run started with `verify-tui start`, whose `verify-tui doctor` reports only `ok:` lines.
- The shell has `V`, `RUN_DIR`, `SESSION`, `PANE` and the `h` function from `SKILL.md`.
- A session is open and the sidebar shows `Pull requests` and `No pull requests attached` (see Drive in `SKILL.md`).
- `gh` is signed in or `GH_TOKEN` is set. The recipes use pull requests in `hcrosse/opencode-pr-tracker` whose state no longer changes:
  - #78 and #79, a merged two-member Stack
  - #112, merged and standalone

## Driving conventions

- Type slash commands with `h send-text "$PANE" '<command>'`, then submit with `h send-keys "$PANE" enter`.
- Wait with `h wait-output "$PANE" --source visible --match '<text>' --timeout <ms>`. Match text only the result prints, not the command you typed.
- Dialogs open with the first row selected, and take `down`, `up`, `enter` and `esc` through `h send-keys`.
- Wait about a second after a dialog appears before sending keys, and between typing a command and pressing `enter`. Keys sent while the dialog is still taking focus can be lost, which leaves it open with no toast.
- Toasts cover the top of the sidebar for a few seconds. Before capturing the heading, wait until the toast text is gone:
  `until ! h read "$PANE" --source visible | grep -q '<toast text>'; do sleep 0.5; done`
- Leave about five seconds between commands, so the previous toast does not satisfy the next wait.

## Order

The steps within a feature file run in order, and each assumes the ones before it. The two files share their first step, attaching #78, so do it once and take both captures. For a narrower request, run the baseline, then only the steps it needs and the steps they depend on.

## Proof and skip reporting

- Capture the state after each action with `$V capture "$RUN_DIR" <feature>-<step>`, and quote the relevant lines of the `.txt` capture in your report.
- Colors and attributes are evidence only in the `.ansi` capture. `freeze` does not draw strikethrough.
- Report a step you could not reach with the command you ran and the unmet precondition. Do not substitute a unit test for a skipped step.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the behavior. It then uses exactly four H2 sections, in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with herdr`, and `Gotchas`.

## Features

- [Sidebar](./sidebar.md): the empty state, Stack markers and gaps, status and titles, and the collapsible heading.
- [Commands](./commands.md): `/pr-attach`, `/pr-sync`, `/pr-detach` and `/pr-open`, with their messages and failures.

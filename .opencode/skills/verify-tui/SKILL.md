---
name: verify-tui
description: Use when verifying the opencode-pr-tracker terminal sidebar or its /pr-attach, /pr-detach, /pr-sync and /pr-open commands in a real OpenCode terminal, including capturing screenshots for a pull request that touches the TUI.
---

# Verify the terminal UI

Proves the plugin's terminal behavior by running OpenCode with this checkout's build in an isolated, headless Herdr session. You type the commands a user types, then read the screen. Every run owns a directory under `$TMPDIR` and a Herdr session named `prt-verify-<run id>`. Nothing else is touched.

The helper is `.opencode/skills/verify-tui/scripts/verify-tui`, run from the repository root. Driving uses raw `herdr` commands so each step matches what a user does.

## Launch

Prerequisites: `bun`, `herdr`, `mise` (for `freeze`), `python3`, and an OpenCode 2 binary. Use the binary the repository requires. Until anomalyco/opencode#50760 merges, that is `opencode-pr50760`. For GitHub features, sign in with `gh`, or set `GH_TOKEN`.

```sh
V=.opencode/skills/verify-tui/scripts/verify-tui
RUN_DIR=$(OPENCODE_BIN=$(command -v opencode-pr50760) $V start | tail -1)
source "$RUN_DIR/state.env"   # RUN_ID, RUN_DIR, SESSION, PANE, OPENCODE, ROOT
h() { herdr --session "$SESSION" pane "$@"; }
```

If each command runs in a fresh shell, as agent tools do, restore these at the start of every step: `V=.opencode/skills/verify-tui/scripts/verify-tui; source "$RUN_DIR/state.env"; h() { herdr --session "$SESSION" pane "$@"; }`, with `RUN_DIR` set to the printed path.

`start` does the following:

1. Runs `bun run build`, which rewrites the gitignored `dist/` in this checkout. That is the build under test.
2. Creates `$RUN_DIR` with an isolated `home/`, a scratch git `project/` whose `.opencode/opencode.json` loads the plugin from this checkout, and `bin/` with recording `open` and `xdg-open`.
3. Starts `herdr --session $SESSION server`.
4. Runs `$OPENCODE --standalone` in its pane, with `bin/` first on `PATH` and `GH_TOKEN` passed through.
5. Waits up to 60 seconds for `ctrl+p commands` on screen.

It prints `RUN_DIR` last. If it fails, it names the `stop` command to run.

## Doctor

```sh
$V doctor "$RUN_DIR"
```

Every line must read `ok:`, and the exit code must be 0. It checks:

- the run belongs to this checkout
- the Herdr session is running
- OpenCode is the pane's foreground process
- the project loads this checkout's plugin
- `dist/` is newer than every file in `src/`
- OpenCode keeps its data in the run's home
- the OpenCode process has the recording openers first on `PATH`, so `/pr-open` cannot launch a real browser

If the build is stale or any check fails, run `stop` and start again. Do not drive a run that fails Doctor.

## Drive

Start from a session with the sidebar open. A `!` shell command creates a session without calling a model:

```sh
h send-text "$PANE" "!printf 'session %s\\n' ready"; h send-keys "$PANE" enter
h wait-output "$PANE" --source visible --match 'session ready' --timeout 20000
h send-keys "$PANE" ctrl+x; h send-keys "$PANE" b
h wait-output "$PANE" --source visible --match 'No pull requests attached' --timeout 20000
```

Then follow the feature recipes in [`features/README.md`](features/README.md).

## Evidence

```sh
$V capture "$RUN_DIR" <name>   # lowercase-with-hyphens
```

`capture` writes `$RUN_DIR/artifacts/<name>.txt` (plain screen), `<name>.ansi` (colors and attributes), and `<name>.png` (a `freeze` screenshot for pull request descriptions). `/pr-open` appends each opened URL to `$RUN_DIR/artifacts/opened.txt`.

- **Pass:** each recipe's expected text appears in the named capture, and `opened.txt` lists exactly the URLs chosen.
- **Fail:** a toast shows an error you did not provoke, or the sidebar contradicts the expected rows.
- **Inconclusive:** Doctor failed, GitHub was unreachable (the toast says so), or no `GH_TOKEN` was available. Report it as such, and do not claim a pass from a lower-level test.

Captures contain only what the screen shows. The token is never written to `$RUN_DIR`.

## Cleanup

```sh
$V stop "$RUN_DIR"
```

`stop` stops and deletes only this run's Herdr session, then removes `home/`, `project/` and `bin/`. It keeps `artifacts/`, `state.env` and `herdr.log`. It is safe to repeat, and it works after a failed `start`. It refuses any directory not named `opencode-pr-tracker-verify-*`. Remove `$RUN_DIR` yourself once the evidence is no longer needed.

## Not covered

- Mouse input. Herdr sends keys only, so clicking a row or the heading is proven by the UI tests in `test/ui/`, not here.
- The packed npm tarball. `bun run smoke:opencode` covers packaging and the RPC and event paths.
- Agent tools, which need a model.
- Remote servers and multiple locations.

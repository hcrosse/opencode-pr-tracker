# Commands

Four slash commands, also listed in the command palette under `Pull requests`, change or act on the attached pull requests of the session on screen. Each reports its outcome in a toast titled `Pull requests`.

## Sub-features

- `attach-url`: `/pr-attach <url>` attaches a pull request with the rest of its Stack.
- `attach-number-outside`: `/pr-attach <number>` outside a GitHub repository explains that a URL is needed, and changes nothing.
- `sync`: `/pr-sync` refreshes every attached pull request now and reports how many.
- `detach`: `/pr-detach` offers the attached pull requests in a dialog and detaches the chosen one.
- `open`: `/pr-open` offers the attached pull requests and opens the chosen one in the browser.

## How to get to it (user POV)

- Type the command in the prompt of an open session. `/pr-attach` accepts its target after the command, or asks for one when none is given.
- Or open the command palette with ctrl+p and choose `Attach pull request`, `Sync pull request status`, `Detach pull request`, or `Open pull request`.

## Driving it with herdr

Preconditions: the baseline in `README.md`.

- **Attach by URL.** Send `/pr-attach github.com/hcrosse/opencode-pr-tracker/pull/78` and press enter. Wait for `feat: add guided feedback command`, then capture `commands-attach`. The capture contains the toast `Attached hcrosse/opencode-pr-tracker#78 with the rest of its Stack (2 pull requests).` and both Stack rows.
- **Attach by number outside a GitHub repository.** Send `/pr-attach 120` and press enter. Wait for `not a GitHub repository`, then capture `commands-rejected`. The toast says the directory is not a GitHub repository that gh can see and suggests the pull request URL. The sidebar is unchanged.
- **Sync.** Send `/pr-sync` and press enter. Wait for `Synced 2 pull requests.`
- **Open.** Send `/pr-open` and press enter. Wait for `Open pull request`, then capture `commands-open-dialog`. The dialog lists `hcrosse/opencode-pr-tracker#78` and `#79`. Press `down`, then `enter`, to choose #79. Poll until `$RUN_DIR/artifacts/opened.txt` exists. It contains exactly `https://github.com/hcrosse/opencode-pr-tracker/pull/79`, and no toast appears.
- **Detach.** Send `/pr-detach` and press enter. Wait for `Detach pull request`, then capture `commands-detach-dialog`. The dialog lists `hcrosse/opencode-pr-tracker#78` and `#79`. Press `down`, then `enter`, to choose #79. Wait for `Detached hcrosse/opencode-pr-tracker#79.`, then poll `h read "$PANE" --source visible | grep -c 'tracker#79$'` until it prints `0`, and capture `commands-detached`. The sidebar keeps #78.

## Gotchas

- Each toast lasts several seconds. A wait for `Attached` can match the previous attach's toast, so match text unique to this step, such as a title or number.
- `/pr-open` really opens a browser unless Doctor's opener check passed. Never skip Doctor.
- Detach and open list pull requests in sidebar order, so `down` counts rows from the top of that list.
- Without `GH_TOKEN`, or with `gh` signed out, attach reports `GitHub needs you to sign in` instead. Report that as inconclusive.

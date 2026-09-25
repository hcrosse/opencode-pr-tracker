# Sidebar

The sidebar lists a session's attached pull requests, with each one's repository, number, status and title. Members of a GitHub Stack are joined by Stack markers. Lists longer than two can be collapsed from the heading.

## Sub-features

- `sidebar-empty`: a session with nothing attached shows `No pull requests attached`.
- `sidebar-stack`: Stack members appear together, bottom first, joined by `┌─`, `│` and `└─`.
- `sidebar-incomplete`: a lone attached member of a larger Stack uses `├─`, with `┊` below it.
- `sidebar-status`: each row shows its status label, and in the default layout its title. Merged pull requests are purple, bold and struck through.
- `sidebar-heading`: with more than two pull requests, the heading gains a `▼` marker.
- `sidebar-regrouped`: Stack members stored apart, as after `gh stack link`, are regrouped in storage and drawn together again.

## How to get to it (user POV)

- Open a session, then show the sidebar with ctrl+x b, or from the command palette's `Show sidebar`.
- The sidebar follows the session on screen. It updates after every command, and every 15 seconds for open pull requests.

## Driving it with herdr

Preconditions: the baseline in `README.md`.

- **Empty.** With the sidebar open, run `$V capture "$RUN_DIR" sidebar-empty`. `sidebar-empty.txt` contains `Pull requests` and `No pull requests attached`.
- **Stack.** Attach #78 with `/pr-attach github.com/hcrosse/opencode-pr-tracker/pull/78`, and wait for `feat: add guided feedback command`. After the toast clears, run `$V capture "$RUN_DIR" sidebar-stack`. The capture shows `┌─ hcrosse/opencode-pr-tracker#78`, a line starting `│  merged`, then `└─ hcrosse/opencode-pr-tracker#79`, and under each its `merged` label and title.
- **Status attributes.** Find the escape codes in front of each reference:
  `python3 -c 'import re,sys; [print(m.group(1).replace("\x1b","ESC"), m.group(2)) for m in re.finditer(r"((?:\x1b\[[0-9;]*m)+)(hcrosse/opencode-pr-tracker#\d+)", open(sys.argv[1]).read())]' "$RUN_DIR/artifacts/sidebar-stack.ansi"`
  Each reference has `ESC[1m` (bold), `ESC[9m` (strikethrough) and one shared `38;2;…` purple. In the default opencode theme it is `38;2;178;151;248`.
- **Heading.** Attach #112 with `/pr-attach https://github.com/hcrosse/opencode-pr-tracker/pull/112`, and wait for `compact sidebar layout`. After the toast clears, run `$V capture "$RUN_DIR" sidebar-heading`. The capture shows `▼ Pull requests`, then the two Stack rows, then `•  hcrosse/opencode-pr-tracker#112`.
- **Regrouped Stack.** After **Heading**, before detaching anything, reorder the stored attachments so #112 sits between the Stack members. Commands cannot do this, because attaching always groups a Stack. Edit the run's isolated database:
  `DB="$RUN_DIR/home/.local/share/opencode/opencode.db"; sqlite3 "$DB" "select value from kv where key like '%session/%'"` shows `{"pullRequests":[…#112, #78, #79…],"version":1}`. Write the same entries back in the order #78, #112, #79 with `sqlite3 "$DB" "update kv set value='…' where key like '%session/%'"`. Then run `/pr-sync`, and after the toast clears, run `$V capture "$RUN_DIR" sidebar-regrouped`. The capture shows `┌─ hcrosse/opencode-pr-tracker#78`, `└─ hcrosse/opencode-pr-tracker#79`, then `•  hcrosse/opencode-pr-tracker#112`. The stored value now lists #78, #79, #112, and a second `/pr-sync` leaves its `time_updated` unchanged.
- **Incomplete Stack.** Detach #79 as in `commands.md`. After the toast clears, run `$V capture "$RUN_DIR" sidebar-incomplete`. The capture shows `├─ hcrosse/opencode-pr-tracker#78`, with `┊  merged` below it, and no `#79` row.

## Gotchas

- At 120 columns the sidebar is hidden until ctrl+x b. Hiding and showing it again remounts it, which reloads the list but keeps whether the heading was collapsed.
- The `Getting started` panel at the bottom of the sidebar is OpenCode's own, not the plugin's.
- Long references wrap in the narrow sidebar, so `merged` often sits on the next line, after the Stack line. Match lines by their marker and text, not by column.
- Collapsing needs a mouse click on the heading, which Herdr cannot send. The `▼` marker proves the list is collapsible; `test/ui/Sidebar.test.tsx` proves the click.

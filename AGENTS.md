# Agent guidance

Follow [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, and pull request titles.

## Checks

`bun run check` must pass before a pull request. It runs lint, format, type checks, tests, and a package dry run.

Lint uses a strict oxlint profile (`.oxlintrc.jsonc`) with every correctness, pedantic, perf, restriction, and suspicious rule enabled, type-aware checks, and the repository's `anti-slop` rules in `tools/oxlint/anti-slop/`. Code that passes a default lint setup often fails here. Rules that new code most often breaks:

- A type assertion needs a `// SAFETY:` comment stating the checked invariant, and chained assertions such as `as unknown as T` are rejected. Narrow with a parser or a precise type instead, such as a small interface for the fields a function reads.
- Object spread, spreading an accumulator in a loop, and passing a function reference directly to `map` or `filter` are rejected.
- Parameters must be readonly types, and statements need blank lines between logical groups.
- Test functions count toward the 40-line function limit.

Run `bun run lint` on a new module as soon as it compiles, not only at the end.

## Terminal UI

Verify sidebar and command changes with the project skill in `.opencode/skills/verify-tui/`, which runs this checkout's build in an isolated OpenCode.

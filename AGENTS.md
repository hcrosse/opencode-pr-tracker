# Agent guidance

Follow [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, and pull request titles.

## Checks

Two checks must pass before a pull request:

- `bun run check` runs lint, format, type checks, tests, and a package dry run.
- The prek check group adds shell, workflow, and data-file checks that CI also runs. In a Git checkout, run `mise run lint`. In a jj workspace, run `JJ_CHECK_SETUP="bun ci" jj check`; `mise run lint` refuses to run where Git resolves to another checkout, because prek would check no files there.

Install dependencies with `bun ci`, which keeps `bun.lock` unchanged.

Lint uses a strict oxlint profile (`.oxlintrc.jsonc`) with every correctness, pedantic, perf, restriction, and suspicious rule enabled, type-aware checks, and the repository's `anti-slop` rules in `tools/oxlint/anti-slop/`. Code that passes a default lint setup often fails here. Rules that new code most often breaks:

- A type assertion needs a `// SAFETY:` comment stating the checked invariant, and chained assertions such as `as unknown as T` are rejected. `as const` is exempt. Narrow with a parser or a precise type instead, such as a small interface for the fields a function reads.
- Object spread such as `{ ...base, key }` is rejected (`oxc/no-rest-spread-properties`), including spreading an accumulator in a loop. Build the object with each property named. Array spread is allowed.
- Passing a function reference directly to `map` or `filter` is rejected. Use an arrow function.
- Parameters must be readonly types, and statements need blank lines between logical groups.
- Test functions count toward the 40-line function limit.
- Use `Schema.TaggedUnion` for wire unions and namespaced `Data.taggedEnum` for owned unions. Branch with `match`, `$match`, or `$is`; do not use `Predicate.isTagged` with string literals or `.guards` on typed values.

Run `bun run lint` on a new module as soon as it compiles, not only at the end.

## Terminal UI

Verify sidebar and command changes with the project skill in `.opencode/skills/verify-tui/`, which runs this checkout's build in an isolated OpenCode.

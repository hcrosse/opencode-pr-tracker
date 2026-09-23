# anti-slop provenance

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop/tree/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b), commit `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`.

This snapshot follows v0.1.2 (`e8c4880471b23ab7f216fba7b27d173a6ef07d4c`). Upstream's package version remains `0.1.2`, so use the commit to identify this snapshot.

## Included files

- `src/index.ts`, `src/rules/*.ts` excluding tests, and `src/shared/*.ts`, copied verbatim with `src/` removed.
- `src/vendor/eslint-stylistic/`, including its license and upstream adaptation record, copied verbatim.
- Root `LICENSE`, copied verbatim.

The framework-neutral template includes only the generic plugin. Effect-specific source, upstream tests, installer skills, and upstream development configuration are omitted. Test references and commands in the bundled Stylistic record refer to the anti-slop source repository.

## Local policy and updates

There are no local changes to the copied source. The template owns rule enablement in `.oxlintrc.jsonc` and excludes the plugin from project formatting and linting. Oxlint and `@oxlint/plugins` remain pinned together in `package.json`.

For a future update, compare local source against this commit before incorporating the incoming revision. Preserve local customizations, review added rules, and update this record and the generated README. Keep both licenses. Verify a generated project's lint, formatting, tests, and build, including rule rejection and spacing autofix behavior.

import { expect, test } from "bun:test"

import { isConventionalPullRequestTitle } from "../scripts/check-pr-title.js"

test.each([
  "feat: add npm installation",
  "fix(tui): retain stale status",
  "feat!: remove legacy configuration",
  "chore(main): release 0.1.0",
])("accepts conventional pull request title %s", (title) => {
  expect(isConventionalPullRequestTitle(title)).toBe(true)
})

test.each(["Add npm installation", "feature: add npm installation", "feat add npm installation", "feat: "])(
  "rejects non-conventional pull request title %s",
  (title) => {
    expect(isConventionalPullRequestTitle(title)).toBe(false)
  },
)

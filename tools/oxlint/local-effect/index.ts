import { eslintCompatPlugin } from "@oxlint/plugins"

import { noEffectGenWrapperRule } from "./rules/no-effect-gen-wrapper.ts"
import { noRunOutsideEntrypointsRule } from "./rules/no-run-outside-entrypoints.ts"
import { noSleepInTestsRule } from "./rules/no-sleep-in-tests.ts"
import { requireEffectFnNameRule } from "./rules/require-effect-fn-name.ts"
import { requireReturnOnFailRule } from "./rules/require-return-on-fail.ts"

/** Project-owned Oxlint rules for Effect function, failure, test, and runtime conventions. */
const localEffectPlugin = eslintCompatPlugin({
  meta: { name: "local-effect" },
  rules: {
    "no-effect-gen-wrapper": noEffectGenWrapperRule,
    "no-run-outside-entrypoints": noRunOutsideEntrypointsRule,
    "no-sleep-in-tests": noSleepInTestsRule,
    "require-effect-fn-name": requireEffectFnNameRule,
    "require-return-on-fail": requireReturnOnFailRule,
  },
})

export default localEffectPlugin

import { defineRule } from "@oxlint/plugins"
import type { ESTree, Visitor } from "@oxlint/plugins"

import { isEffectCall, TEST_FILE } from "../shared/effect-namespace.ts"

/** Keep tests deterministic by controlling time instead of waiting for it. */
export const noSleepInTestsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow Effect.sleep in test and spec files.",
    },
    messages: {
      sleepInTest:
        "Do not wait on real time in tests. Advance virtual time with TestClock from effect/testing, or synchronize with Deferred, Queue, or Latch.",
    },
  },
  create(context): Visitor {
    if (!TEST_FILE.test(context.filename)) return {}

    return {
      CallExpression(node: ESTree.CallExpression): void {
        if (isEffectCall(context.sourceCode, node, "sleep")) {
          context.report({ node, messageId: "sleepInTest" })
        }
      },
    }
  },
})

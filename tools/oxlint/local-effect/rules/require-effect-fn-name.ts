import { defineRule } from "@oxlint/plugins"
import type { ESTree, SourceCode, VisitorWithHooks } from "@oxlint/plugins"

import { isEffectCall, resolveVariable } from "../shared/effect-namespace.ts"
import { isFunctionExpression, isLocalFunction } from "../shared/local-function.ts"

function isFunctionValue(sourceCode: SourceCode, node: ESTree.Node): boolean {
  if (isFunctionExpression(node)) return true

  if (node.type !== "Identifier") return false

  return isLocalFunction(resolveVariable(sourceCode, node))
}

/** Require a span name when Effect.fn is used for tracing. */
export const requireEffectFnNameRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require Effect.fn to receive a span name rather than an inline or locally declared function.",
    },
    messages: {
      missingName:
        'Pass a span name first: Effect.fn("Domain.operation")(function* (...) { ... }). Use Effect.fnUntraced when tracing is intentionally unnecessary.',
    },
  },
  createOnce(context): VisitorWithHooks {
    return {
      CallExpression(node: ESTree.CallExpression): void {
        if (!isEffectCall(context.sourceCode, node, "fn")) return

        const first = node.arguments.at(0) ?? null

        if (first === null) return

        if (isFunctionValue(context.sourceCode, first)) {
          context.report({ node: first, messageId: "missingName" })
        }
      },
    }
  },
})

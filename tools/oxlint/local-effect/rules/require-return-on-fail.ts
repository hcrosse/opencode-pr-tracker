import { defineRule } from "@oxlint/plugins"
import type { ESTree, SourceCode, Variable, VisitorWithHooks } from "@oxlint/plugins"

import { isEffectCall } from "../shared/effect-namespace.ts"
import { isLocalFunction } from "../shared/local-function.ts"

function nearestFunction(node: ESTree.Node): ESTree.Node | null {
  let current = node.parent

  while (current !== null) {
    if (current.type === "FunctionExpression" || current.type === "FunctionDeclaration") {
      return current
    }

    current = current.parent
  }

  return null
}

const EFFECT_GENERATOR_RUNNERS = ["fn", "fnUntraced", "gen"]

function isEffectGeneratorCall(sourceCode: SourceCode, call: ESTree.CallExpression): boolean {
  if (EFFECT_GENERATOR_RUNNERS.some((name) => isEffectCall(sourceCode, call, name))) return true

  return isEffectCall(sourceCode, call.callee, "fn")
}

function isPassedToEffectRunner(sourceCode: SourceCode, node: ESTree.Node): boolean {
  const call = node.parent

  return call !== null && call.type === "CallExpression" && isEffectGeneratorCall(sourceCode, call)
}

function generatorBindings(sourceCode: SourceCode, generator: ESTree.Node): Variable[] {
  if (generator.type === "FunctionDeclaration") return sourceCode.getDeclaredVariables(generator)

  const { parent } = generator

  if (parent !== null && parent.type === "VariableDeclarator" && parent.init === generator) {
    return sourceCode.getDeclaredVariables(parent)
  }

  return []
}

function isEffectGenerator(sourceCode: SourceCode, node: ESTree.Node): boolean {
  const generator = nearestFunction(node)

  if (generator === null) return false

  if (isPassedToEffectRunner(sourceCode, generator)) return true

  return generatorBindings(sourceCode, generator).some(
    (variable) =>
      isLocalFunction(variable) &&
      variable.references.some((reference) =>
        isPassedToEffectRunner(sourceCode, reference.identifier),
      ),
  )
}

/** Make terminal failures visible to TypeScript's control-flow analysis. */
export const requireReturnOnFailRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require `return yield*` when a generator passed to Effect.gen, Effect.fn, or Effect.fnUntraced, inline or by local name, yields Effect.fail or a newly constructed error.",
    },
    messages: {
      missingReturn:
        "Write `return yield* ...` so TypeScript knows control stops after this failure.",
    },
  },
  createOnce(context): VisitorWithHooks {
    return {
      ExpressionStatement(node: ESTree.ExpressionStatement): void {
        const { expression } = node

        if (expression.type !== "YieldExpression" || !expression.delegate) return

        const { argument } = expression

        if (
          argument !== null &&
          isEffectGenerator(context.sourceCode, node) &&
          (argument.type === "NewExpression" || isEffectCall(context.sourceCode, argument, "fail"))
        ) {
          context.report({ node, messageId: "missingReturn" })
        }
      },
    }
  },
})

import { defineRule } from "@oxlint/plugins"
import type { ESTree, SourceCode, VisitorWithHooks } from "@oxlint/plugins"

import { isEffectCall } from "../shared/effect-namespace.ts"

type FunctionNode = ESTree.ArrowFunctionExpression | ESTree.Function

function onlyReturnsEffectGen(sourceCode: SourceCode, node: FunctionNode): boolean {
  const { body } = node

  if (body === null) return false

  if (body.type !== "BlockStatement") return isEffectCall(sourceCode, body, "gen")

  const statement = body.body.length === 1 ? (body.body.at(0) ?? null) : null

  return (
    statement !== null &&
    statement.type === "ReturnStatement" &&
    isEffectCall(sourceCode, statement.argument, "gen")
  )
}

function propertyName(property: ESTree.ObjectProperty): string | null {
  if (property.computed || property.kind !== "init") return null

  const { key } = property

  if (key.type === "Identifier") return key.name

  return key.type === "Literal" ? String(key.value) : null
}

function wrapperName(node: FunctionNode): string | null {
  if (node.type === "FunctionDeclaration") return node.id === null ? null : node.id.name

  const { parent } = node

  if (parent.type === "VariableDeclarator" && parent.init === node) {
    return parent.id.type === "Identifier" ? parent.id.name : null
  }

  return parent.type === "Property" && parent.value === node ? propertyName(parent) : null
}

/** Prefer traced Effect functions over plain functions that only build an Effect.gen. */
export const noEffectGenWrapperRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow named synchronous, non-generator functions whose whole body is Effect.gen.",
    },
    messages: {
      genWrapper:
        'Function "{{name}}" only wraps Effect.gen. Define it as Effect.fn("{{name}}")(function* (...) { ... }) so calls get a span, or use Effect.fnUntraced when tracing is unnecessary.',
    },
  },
  createOnce(context): VisitorWithHooks {
    function check(node: FunctionNode): void {
      if (node.async || node.generator) return

      const name = wrapperName(node)

      if (name === null || !onlyReturnsEffectGen(context.sourceCode, node)) return

      context.report({ node, messageId: "genWrapper", data: { name } })
    }

    return {
      ArrowFunctionExpression: check,
      FunctionDeclaration: check,
      FunctionExpression: check,
    }
  },
})

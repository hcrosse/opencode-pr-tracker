import type { Definition, ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins"

export const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u

export function resolveVariable(
  sourceCode: SourceCode,
  identifier: ESTree.Node & { readonly name: string },
): Variable | null {
  let scope: Scope | null = sourceCode.getScope(identifier)

  while (scope !== null) {
    const variable = scope.set.get(identifier.name)

    if (variable) return variable

    scope = scope.upper
  }

  return null
}

function importsEffectModule(definition: Definition): boolean {
  if (definition.type !== "ImportBinding" || definition.parent === null) return false

  if (definition.parent.type !== "ImportDeclaration") return false

  const source = definition.parent.source.value
  const specifier = definition.node

  if (specifier.type === "ImportNamespaceSpecifier") return source === "effect/Effect"

  if (specifier.type !== "ImportSpecifier" || source !== "effect") return false

  const { imported } = specifier

  return (imported.type === "Identifier" ? imported.name : imported.value) === "Effect"
}

/** Return the member name when `node` is `Effect.<name>` on the Effect module imported from "effect" or "effect/Effect". */
export function effectMemberName(sourceCode: SourceCode, node: ESTree.Node): string | null {
  if (node.type !== "MemberExpression" || node.computed) return null

  if (node.object.type !== "Identifier" || node.property.type !== "Identifier") return null

  const variable = resolveVariable(sourceCode, node.object)

  if (variable === null || !variable.defs.some(importsEffectModule)) return null

  return node.property.name
}

export function isEffectCall(
  sourceCode: SourceCode,
  node: ESTree.Node | null,
  name: string,
): node is ESTree.CallExpression {
  if (node === null || node.type !== "CallExpression") return false

  return effectMemberName(sourceCode, node.callee) === name
}

import type { Definition, ESTree, Variable } from "@oxlint/plugins"

export function isFunctionExpression(node: ESTree.Node | null): boolean {
  if (node === null) return false

  return node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression"
}

function definesFunction(definition: Definition): boolean {
  if (definition.type === "FunctionName") return true

  const declaration = definition.parent

  return (
    definition.type === "Variable" &&
    definition.node.type === "VariableDeclarator" &&
    declaration !== null &&
    declaration.type === "VariableDeclaration" &&
    declaration.kind === "const" &&
    isFunctionExpression(definition.node.init)
  )
}

/** True when the binding is a function declaration or a single `const` initialized with a function expression. */
export function isLocalFunction(variable: Variable | null): boolean {
  return variable !== null && variable.defs.length === 1 && variable.defs.every(definesFunction)
}

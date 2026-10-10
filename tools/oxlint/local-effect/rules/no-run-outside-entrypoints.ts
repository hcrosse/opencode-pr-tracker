import path from "node:path"

import { defineRule } from "@oxlint/plugins"
import type { ESTree, Options, Visitor } from "@oxlint/plugins"

import { effectMemberName, TEST_FILE } from "../shared/effect-namespace.ts"

const RUNNERS = new Set([
  "runCallback",
  "runCallbackWith",
  "runFork",
  "runForkWith",
  "runPromise",
  "runPromiseExit",
  "runPromiseExitWith",
  "runPromiseWith",
  "runSync",
  "runSyncExit",
  "runSyncExitWith",
  "runSyncWith",
])

function entrypointPatterns(options: Readonly<Options>): string[] {
  const first = options.at(0) ?? null

  if (first === null || Array.isArray(first) || !(first instanceof Object)) {
    return []
  }

  const patterns = first["entrypoints"]

  return Array.isArray(patterns) ? patterns.map(String) : []
}

/** Keep Effect execution at the program edge so effects compose until an entrypoint runs them. */
export const noRunOutsideEntrypointsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Effect.run* outside configured entrypoint, test, and spec files. Entrypoint globs match file paths relative to the directory Oxlint runs from.",
    },
    messages: {
      runOutsideEntrypoint:
        "Return the Effect instead of calling Effect.{{runner}} here. Run programs only in a file matched by this rule's `entrypoints` option.",
    },
    schema: [
      {
        type: "object",
        properties: {
          entrypoints: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context): Visitor {
    const file = path.relative(context.cwd, context.filename).replaceAll("\\", "/")

    if (TEST_FILE.test(file)) return {}

    if (entrypointPatterns(context.options).some((pattern) => path.matchesGlob(file, pattern))) {
      return {}
    }

    return {
      MemberExpression(node: ESTree.MemberExpression): void {
        const runner = effectMemberName(context.sourceCode, node)

        if (runner === null || !RUNNERS.has(runner)) return

        context.report({ node, messageId: "runOutsideEntrypoint", data: { runner } })
      },
    }
  },
})

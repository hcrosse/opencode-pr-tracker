import { Array as Arr, Option, Result, Schema } from "effect"

import { parsePullRequestUrl } from "../../domain/PullRequest.ts"
import { Membership } from "../../domain/StackLayout.ts"

export const LifecycleState = Schema.Literals(["OPEN", "CLOSED", "MERGED"])

export const StackNode = Schema.Struct({
  entries: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        position: Schema.Int,
        pullRequest: Schema.Struct({ state: LifecycleState, url: Schema.String }),
      }),
    ),
    pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean }),
  }),
  id: Schema.String,
  size: Schema.Int,
})

/** The Stack field of a pull request node. */
interface Stacked {
  readonly stack: typeof StackNode.Type | null
}

/** None when GitHub returned only part of the Stack, or a member URL we cannot parse. */
export function toMembership(node: Stacked): Option.Option<Membership> {
  if (node.stack === null) return Option.some(Membership.cases.Standalone.make({}))

  const { entries, id, size } = node.stack
  const ordered = entries.nodes.toSorted((left, right) => left.position - right.position)

  const members = ordered.flatMap((entry) =>
    Option.toArray(Result.getSuccess(parsePullRequestUrl(entry.pullRequest.url))),
  )

  const complete = !entries.pageInfo.hasNextPage && members.length === size

  return complete && Arr.isArrayNonEmpty(members)
    ? Option.some(Membership.cases.Stack.make({ id, members }))
    : Option.none()
}

/** Canonical URLs of the Stack members GitHub reports as merged or closed. */
export function nonOpenMembersOf(node: Stacked): readonly string[] {
  const entries = node.stack === null ? [] : node.stack.entries.nodes

  return entries.flatMap((entry) =>
    entry.pullRequest.state === "OPEN"
      ? []
      : Option.toArray(Result.getSuccess(parsePullRequestUrl(entry.pullRequest.url))).map(
          (member) => member.url,
        ),
  )
}

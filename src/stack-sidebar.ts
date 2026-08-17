import type { SidebarPullRequest } from "./polling.js"

export type StackSidebarRow =
  | Readonly<{
      tag: "PullRequest"
      item: SidebarPullRequest
      marker: "•  " | "┌─ " | "├─ " | "└─ "
      titleMarker: "│  " | "┊  " | "   "
    }>
  | Readonly<{ tag: "Gap"; count: number; label: string }>

type StackItem = Readonly<{
  itemIndex: number
  item: SidebarPullRequest
  members: readonly string[]
  memberPosition: number
}>

function ordinaryRow(item: SidebarPullRequest): StackSidebarRow {
  return { tag: "PullRequest", item, marker: "•  ", titleMarker: "   " }
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((member, index) => member === right[index])
}

export function projectStackSidebarRows(items: readonly SidebarPullRequest[]): readonly StackSidebarRow[] {
  const reportedStacks = new Map<string, Array<{ itemIndex: number; item: SidebarPullRequest }>>()
  const stackIdsByMembers = new Map<string, Set<string>>()
  const stackIdsByMember = new Map<string, Set<string>>()
  const attachedItems = new Map(items.map((item) => [item.attachment.pullRequest.url, item]))
  for (const [itemIndex, item] of items.entries()) {
    if (item.membership?.tag !== "Stack") continue
    const reported = reportedStacks.get(item.membership.id) ?? []
    reported.push({ itemIndex, item })
    reportedStacks.set(item.membership.id, reported)
    const membersKey = JSON.stringify(item.membership.members.map((member) => member.url))
    const reportedIds = stackIdsByMembers.get(membersKey) ?? new Set()
    reportedIds.add(item.membership.id)
    stackIdsByMembers.set(membersKey, reportedIds)
    for (const member of item.membership.members) {
      const stackIds = stackIdsByMember.get(member.url) ?? new Set()
      stackIds.add(item.membership.id)
      stackIdsByMember.set(member.url, stackIds)
    }
  }

  const contradictoryStackIds = new Set<string>()
  for (const stackIds of stackIdsByMember.values()) {
    if (stackIds.size > 1) for (const stackId of stackIds) contradictoryStackIds.add(stackId)
  }

  const validStackItems = new Map<number, Readonly<{ stack: readonly StackItem[]; stackIndex: number }>>()
  for (const reported of reportedStacks.values()) {
    const firstMembership = reported[0]?.item.membership
    if (firstMembership?.tag !== "Stack") continue
    if (contradictoryStackIds.has(firstMembership.id)) continue
    const members = firstMembership.members.map((member) => member.url)
    if (stackIdsByMembers.get(JSON.stringify(members))?.size !== 1) continue
    if (new Set(members).size !== members.length) continue

    const stack: StackItem[] = []
    let valid = members.every((member) => {
      const attached = attachedItems.get(member)
      return (
        attached === undefined ||
        (attached.membership?.tag === "Stack" &&
          attached.membership.id === firstMembership.id &&
          sameMembers(
            members,
            attached.membership.members.map((stackMember) => stackMember.url),
          ))
      )
    })
    valid &&= reported.every(
      ({ item }) =>
        item.membership?.tag === "Stack" &&
        sameMembers(
          members,
          item.membership.members.map((member) => member.url),
        ),
    )
    for (const [stackIndex, entry] of reported.entries()) {
      const memberPosition = members.indexOf(entry.item.attachment.pullRequest.url)
      if (memberPosition < 0) {
        valid = false
        break
      }
      if (stackIndex > 0) {
        const previous = stack[stackIndex - 1]!
        if (entry.itemIndex !== previous.itemIndex + 1 || memberPosition <= previous.memberPosition) {
          valid = false
          break
        }
      }
      stack.push({ ...entry, members, memberPosition })
    }
    if (!valid) continue
    for (const [stackIndex, entry] of stack.entries()) validStackItems.set(entry.itemIndex, { stack, stackIndex })
  }

  const rows: StackSidebarRow[] = []
  for (const [itemIndex, item] of items.entries()) {
    const valid = validStackItems.get(itemIndex)
    if (valid === undefined) {
      rows.push(ordinaryRow(item))
      continue
    }

    const current = valid.stack[valid.stackIndex]!
    const previous = valid.stack[valid.stackIndex - 1]
    if (previous !== undefined) {
      const count = current.memberPosition - previous.memberPosition - 1
      if (count > 0) {
        rows.push({ tag: "Gap", count, label: count === 1 ? "1 PR not attached" : `${count} PRs not attached` })
      }
    }

    const isFirstAttached = valid.stackIndex === 0
    const isLastAttached = valid.stackIndex === valid.stack.length - 1
    const marker =
      valid.stack.length === 1 && current.members.length > 1
        ? "├─ "
        : isFirstAttached && current.memberPosition === 0
          ? "┌─ "
          : isLastAttached && current.memberPosition === current.members.length - 1
            ? "└─ "
            : "├─ "
    const titleMarker = !isLastAttached ? "│  " : current.memberPosition < current.members.length - 1 ? "┊  " : "   "
    rows.push({ tag: "PullRequest", item, marker, titleMarker })
  }
  return rows
}

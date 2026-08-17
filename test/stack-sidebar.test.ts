import { describe, expect, test } from "bun:test"

import type { PullRequestStackMembership } from "../src/github.js"
import type { SidebarPullRequest } from "../src/polling.js"
import { projectStackSidebarRows } from "../src/stack-sidebar.js"
import { parsePullRequestUrl, type PullRequestUrl } from "../src/url.js"

function pullRequest(owner: string, repository: string, number: number): PullRequestUrl {
  const parsed = parsePullRequestUrl(`https://github.com/${owner}/${repository}/pull/${number}`)
  if (!parsed.ok) throw new Error("test fixture URL is invalid")
  return parsed.value
}

function stack(id: string, first: PullRequestUrl, ...rest: PullRequestUrl[]): PullRequestStackMembership {
  return { tag: "Stack", id, members: [first, ...rest] }
}

function sidebarItem(value: PullRequestUrl, membership?: PullRequestStackMembership): SidebarPullRequest {
  return {
    attachment: { pullRequest: value, attachedAt: "2026-08-15T12:00:00.000Z" },
    status: { tag: "Unavailable" },
    ...(membership === undefined ? {} : { membership }),
  }
}

function rowShape(rows: ReturnType<typeof projectStackSidebarRows>) {
  return rows.map((row) =>
    row.tag === "Gap"
      ? row
      : {
          tag: row.tag,
          pullRequest: row.item.attachment.pullRequest.url,
          marker: row.marker,
          titleMarker: row.titleMarker,
        },
  )
}

describe("projectStackSidebarRows", () => {
  test("renders complete Stack boundaries", () => {
    const base = pullRequest("owner", "repository", 12)
    const top = pullRequest("owner", "repository", 13)
    const membership = stack("stack-1", base, top)

    expect(rowShape(projectStackSidebarRows([sidebarItem(base, membership), sidebarItem(top, membership)]))).toEqual([
      { tag: "PullRequest", pullRequest: base.url, marker: "┌─ ", titleMarker: "│  " },
      { tag: "PullRequest", pullRequest: top.url, marker: "└─ ", titleMarker: "   " },
    ])
  })

  test("renders a sole attached remote base as an incomplete Stack unit", () => {
    const members = [801, 802, 803].map((number) => pullRequest("sample", "stack-fixture", number))
    const membership = stack("synthetic-stack", members[0]!, members[1]!, members[2]!)

    expect(rowShape(projectStackSidebarRows([sidebarItem(members[0]!, membership)]))).toEqual([
      { tag: "PullRequest", pullRequest: members[0]!.url, marker: "├─ ", titleMarker: "┊  " },
    ])
  })

  test("renders a sole attached remote head as an incomplete Stack unit", () => {
    const members = [811, 812, 813].map((number) => pullRequest("sample", "stack-fixture", number))
    const membership = stack("synthetic-stack", members[0]!, members[1]!, members[2]!)

    expect(rowShape(projectStackSidebarRows([sidebarItem(members[2]!, membership)]))).toEqual([
      { tag: "PullRequest", pullRequest: members[2]!.url, marker: "├─ ", titleMarker: "   " },
    ])
  })

  test("renders partial Stack members with a singular internal gap", () => {
    const members = [10, 11, 12, 13, 14].map((number) => pullRequest("owner", "repository", number))
    const membership = stack("stack-1", members[0]!, ...members.slice(1))

    expect(
      rowShape(projectStackSidebarRows([sidebarItem(members[1]!, membership), sidebarItem(members[3]!, membership)])),
    ).toEqual([
      { tag: "PullRequest", pullRequest: members[1]!.url, marker: "├─ ", titleMarker: "│  " },
      { tag: "Gap", count: 1, label: "1 PR not attached" },
      { tag: "PullRequest", pullRequest: members[3]!.url, marker: "├─ ", titleMarker: "┊  " },
    ])
  })

  test("renders plural internal gaps without outer gap rows", () => {
    const members = [20, 21, 22, 23, 24].map((number) => pullRequest("owner", "repository", number))
    const membership = stack("stack-1", members[0]!, ...members.slice(1))

    expect(
      rowShape(projectStackSidebarRows([sidebarItem(members[0]!, membership), sidebarItem(members[3]!, membership)])),
    ).toEqual([
      { tag: "PullRequest", pullRequest: members[0]!.url, marker: "┌─ ", titleMarker: "│  " },
      { tag: "Gap", count: 2, label: "2 PRs not attached" },
      { tag: "PullRequest", pullRequest: members[3]!.url, marker: "├─ ", titleMarker: "┊  " },
    ])
  })

  test("distinguishes incomplete lower and upper boundaries", () => {
    const members = [30, 31, 32].map((number) => pullRequest("owner", "repository", number))
    const membership = stack("stack-1", members[0]!, ...members.slice(1))

    expect(
      rowShape(projectStackSidebarRows([sidebarItem(members[1]!, membership), sidebarItem(members[2]!, membership)])),
    ).toEqual([
      { tag: "PullRequest", pullRequest: members[1]!.url, marker: "├─ ", titleMarker: "│  " },
      { tag: "PullRequest", pullRequest: members[2]!.url, marker: "└─ ", titleMarker: "   " },
    ])
    expect(
      rowShape(projectStackSidebarRows([sidebarItem(members[0]!, membership), sidebarItem(members[1]!, membership)])),
    ).toEqual([
      { tag: "PullRequest", pullRequest: members[0]!.url, marker: "┌─ ", titleMarker: "│  " },
      { tag: "PullRequest", pullRequest: members[1]!.url, marker: "├─ ", titleMarker: "┊  " },
    ])
  })

  test("keeps standalone and unknown membership as ordinary pull requests", () => {
    const standalone = pullRequest("owner", "repository", 40)
    const unknown = pullRequest("other", "project", 41)

    expect(
      rowShape(
        projectStackSidebarRows([
          sidebarItem(standalone, { tag: "Standalone", pullRequest: standalone }),
          sidebarItem(unknown),
        ]),
      ),
    ).toEqual([
      { tag: "PullRequest", pullRequest: standalone.url, marker: "•  ", titleMarker: "   " },
      { tag: "PullRequest", pullRequest: unknown.url, marker: "•  ", titleMarker: "   " },
    ])
  })

  test("falls back to ordinary bullets when an attached Stack member reports standalone", () => {
    const members = [45, 46].map((number) => pullRequest("owner", "repository", number))
    const membership = stack("stack-1", members[0]!, members[1]!)

    expect(
      rowShape(
        projectStackSidebarRows([
          sidebarItem(members[0]!, { tag: "Standalone", pullRequest: members[0]! }),
          sidebarItem(members[1]!, membership),
        ]),
      ),
    ).toMatchObject([{ marker: "•  " }, { marker: "•  " }])
  })

  test("falls back to ordinary bullets when an attached Stack member has unknown membership", () => {
    const members = [47, 48].map((number) => pullRequest("owner", "repository", number))
    const membership = stack("stack-1", members[0]!, members[1]!)

    expect(
      rowShape(projectStackSidebarRows([sidebarItem(members[0]!), sidebarItem(members[1]!, membership)])),
    ).toMatchObject([{ marker: "•  " }, { marker: "•  " }])
  })

  test("keeps separate Stacks from one repository as separate units", () => {
    const first = [50, 51].map((number) => pullRequest("owner", "repository", number))
    const second = [52, 53].map((number) => pullRequest("owner", "repository", number))
    const firstMembership = stack("stack-1", first[0]!, first[1]!)
    const secondMembership = stack("stack-2", second[0]!, second[1]!)

    expect(
      rowShape(
        projectStackSidebarRows([
          sidebarItem(first[0]!, firstMembership),
          sidebarItem(first[1]!, firstMembership),
          sidebarItem(second[0]!, secondMembership),
          sidebarItem(second[1]!, secondMembership),
        ]),
      ),
    ).toMatchObject([{ marker: "┌─ " }, { marker: "└─ " }, { marker: "┌─ " }, { marker: "└─ " }])
  })

  test("projects valid Stacks independently across repositories", () => {
    const first = [60, 61].map((number) => pullRequest("owner", "repository", number))
    const second = [70, 71].map((number) => pullRequest("other", "project", number))
    const firstMembership = stack("stack-1", first[0]!, first[1]!)
    const secondMembership = stack("stack-2", second[0]!, second[1]!)

    expect(
      rowShape(
        projectStackSidebarRows([
          sidebarItem(first[0]!, firstMembership),
          sidebarItem(first[1]!, firstMembership),
          sidebarItem(second[0]!, secondMembership),
          sidebarItem(second[1]!, secondMembership),
        ]),
      ),
    ).toMatchObject([{ marker: "┌─ " }, { marker: "└─ " }, { marker: "┌─ " }, { marker: "└─ " }])
  })

  test("falls back to ordinary bullets for split Stack runs", () => {
    const members = [80, 81].map((number) => pullRequest("owner", "repository", number))
    const unrelated = pullRequest("other", "project", 90)
    const membership = stack("stack-1", members[0]!, members[1]!)

    expect(
      rowShape(
        projectStackSidebarRows([
          sidebarItem(members[0]!, membership),
          sidebarItem(unrelated),
          sidebarItem(members[1]!, membership),
        ]),
      ),
    ).toMatchObject([{ marker: "•  " }, { marker: "•  " }, { marker: "•  " }])
  })

  test("falls back to ordinary bullets for reversed Stack positions", () => {
    const members = [100, 101].map((number) => pullRequest("owner", "repository", number))
    const membership = stack("stack-1", members[0]!, members[1]!)

    expect(
      rowShape(projectStackSidebarRows([sidebarItem(members[1]!, membership), sidebarItem(members[0]!, membership)])),
    ).toMatchObject([{ marker: "•  " }, { marker: "•  " }])
  })

  test("falls back to ordinary bullets when reported Stack member lists contradict", () => {
    const members = [110, 111, 112].map((number) => pullRequest("owner", "repository", number))
    const firstMembership = stack("stack-1", members[0]!, members[1]!)
    const secondMembership = stack("stack-1", members[0]!, members[1]!, members[2]!)

    expect(
      rowShape(
        projectStackSidebarRows([
          sidebarItem(members[0]!, firstMembership),
          sidebarItem(members[1]!, secondMembership),
        ]),
      ),
    ).toMatchObject([{ marker: "•  " }, { marker: "•  " }])
  })

  test("falls back to ordinary bullets when complete membership reports contradictory Stack IDs", () => {
    const members = [115, 116].map((number) => pullRequest("owner", "repository", number))
    const firstMembership = stack("stack-1", members[0]!, members[1]!)
    const secondMembership = stack("stack-2", members[0]!, members[1]!)

    expect(
      rowShape(
        projectStackSidebarRows([
          sidebarItem(members[0]!, firstMembership),
          sidebarItem(members[1]!, secondMembership),
        ]),
      ),
    ).toMatchObject([{ marker: "•  " }, { marker: "•  " }])
  })

  test("falls back to ordinary bullets when different Stack IDs report overlapping complete membership", () => {
    const members = [117, 118, 119].map((number) => pullRequest("owner", "repository", number))
    const staleMembership = stack("stack-1", members[0]!, members[1]!)
    const currentMembership = stack("stack-2", members[0]!, members[1]!, members[2]!)

    expect(
      rowShape(
        projectStackSidebarRows([
          sidebarItem(members[0]!, staleMembership),
          sidebarItem(members[1]!, staleMembership),
          sidebarItem(members[2]!, currentMembership),
        ]),
      ),
    ).toMatchObject([{ marker: "•  " }, { marker: "•  " }, { marker: "•  " }])
  })

  test("falls back to ordinary bullets when complete membership excludes a reporting pull request", () => {
    const members = [120, 121].map((number) => pullRequest("owner", "repository", number))
    const contradictory = pullRequest("owner", "repository", 122)
    const membership = stack("stack-1", members[0]!, members[1]!)

    expect(
      rowShape(projectStackSidebarRows([sidebarItem(members[0]!, membership), sidebarItem(contradictory, membership)])),
    ).toMatchObject([{ marker: "•  " }, { marker: "•  " }])
  })
})

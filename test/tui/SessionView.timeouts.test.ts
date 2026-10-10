import { Option } from "effect"
import { describe, expect, test, vi } from "vitest"

import { Update } from "../../src/tui/Client.ts"
import { scripted, showing } from "../support/sessionView.ts"

const unanswered = "The pull request tracker did not answer in time."

describe("sidebar view of a listing that does not answer", () => {
  test("shows why after 5 seconds when it is the session's first, and ignores a late answer", () => {
    const script = scripted("listed")
    const seen: string[] = []

    script.holdLists()
    showing(script, (shown) => {
      script.renewals("die")
      vi.advanceTimersByTime(4999)
      seen.push(shown())
      vi.advanceTimersByTime(1)
      seen.push(shown())
      vi.advanceTimersByTime(55_000)
      script.settle({ title: "late" })
      vi.advanceTimersByTime(120_000)
      seen.push(shown())
    })

    expect(seen).toEqual([
      "loading",
      `failed (TimedOut): ${unanswered}`,
      `failed (TimedOut): ${unanswered}`,
    ])
  })
})

describe("sidebar view of a later listing that does not answer", () => {
  test("keeps the rows stale when listing again does not answer", () => {
    const script = scripted("listed")
    const seen: string[] = []

    showing(script, (shown) => {
      script.renewals("die")
      script.holdLists()
      script.publish(Update.Unreadable({ sessionID: Option.some("a") }))
      vi.advanceTimersByTime(5000)
      seen.push(shown())
      vi.advanceTimersByTime(55_000)
      script.settle({ title: "late" })
      vi.advanceTimersByTime(120_000)
      seen.push(shown())
    })

    expect(seen).toEqual(["stale: listed", "stale: listed"])
  })
})

describe("sidebar view of a listing answered after its lease would have lapsed", () => {
  test("shows the rows stale, as after the computer sleeps mid-listing", () => {
    const script = scripted("listed")
    const seen: string[] = []

    showing(script, (shown) => {
      script.holdLists()
      script.publish(Update.Unreadable({ sessionID: Option.some("a") }))
      // The wall clock moves on while timers do not, as across a system sleep.
      vi.setSystemTime(Date.now() + 60_000)
      script.settle({ title: "relisted" })
      seen.push(shown())
    })

    expect(seen).toEqual(["stale: relisted"])
  })
})

describe("sidebar view of a slow listing", () => {
  test("lets a successful renewal wait for a listing still awaited instead of listing again", () => {
    const script = scripted("listed")
    const seen: string[] = []

    showing(script, (shown) => {
      vi.advanceTimersByTime(13_000)
      script.holdLists()
      script.publish(Update.Unreadable({ sessionID: Option.some("a") }))
      vi.advanceTimersByTime(2000)
      seen.push(`${shown()} after ${script.calls.filter((call) => call === "list a").length}`)
      vi.advanceTimersByTime(2000)
      script.settle({ title: "relisted" })
      seen.push(shown())
    })

    expect(seen).toEqual(["stale: listed after 2", "live: relisted"])
  })
})

describe("sidebar view of a listing that dies", () => {
  test("lists the session again after the next successful renewal", () => {
    const script = scripted("listed")
    const seen: string[] = []

    showing(script, (shown) => {
      script.holdLists()
      script.publish(Update.Unreadable({ sessionID: Option.some("a") }))
      script.settle({ defect: "listing defect" })
      seen.push(shown())
      vi.advanceTimersByTime(15_000)
      script.settle({ title: "relisted" })
      seen.push(shown())
    })

    expect(seen).toEqual(["stale: listed", "live: relisted"])
    expect(script.calls.filter((call) => call === "list a")).toHaveLength(3)
  })
})

describe("sidebar view of a first listing that dies", () => {
  test("lists the session again after the next successful renewal", () => {
    const script = scripted("listed")
    const seen: string[] = []

    script.holdLists()
    showing(script, (shown) => {
      script.settle({ defect: "listing defect" })
      seen.push(shown())
      vi.advanceTimersByTime(15_000)
      script.settle({ title: "relisted" })
      seen.push(shown())
    })

    expect(seen).toEqual(["loading", "live: relisted"])
    expect(script.calls.filter((call) => call === "list a")).toHaveLength(2)
  })
})

import { describe, expect, jest, test } from "bun:test"

import { Option } from "effect"

import { Update } from "../../src/tui/Client.ts"
import { scripted, showing, viewTitled } from "../support/sessionView.ts"

describe("sidebar view when an update cannot be read", () => {
  test("shows stale and lists the session again, then shows it live", () => {
    const script = scripted("listed")
    const seen: string[] = []

    showing(script, (shown) => {
      script.holdLists()
      script.publish(Update.Unreadable({ sessionID: Option.some("a") }))
      seen.push(shown())
      script.settle({ title: "relisted" })
      seen.push(shown())
    })

    expect(seen).toEqual(["stale: listed", "live: relisted"])
    expect(script.calls).toEqual(["list a", "list a"])
  })

  test("treats an update without a readable session as this session's, and ignores another's", () => {
    const script = scripted("listed")
    const seen: string[] = []

    showing(script, (shown) => {
      script.holdLists()
      script.publish(Update.Unreadable({ sessionID: Option.some("b") }))
      seen.push(shown())
      script.publish(Update.Unreadable({ sessionID: Option.none() }))
      seen.push(shown())
    })

    expect(seen).toEqual(["live: listed", "stale: listed"])
    expect(script.calls).toEqual(["list a", "list a"])
  })
})

describe("sidebar view when a listing fails", () => {
  test("shows why when the session's first listing fails", () => {
    const script = scripted("listed")
    const seen: string[] = []

    script.holdLists()
    showing(script, (shown) => {
      script.settle({ failure: "The pull request tracker failed." })
      seen.push(shown())
    })

    expect(seen).toEqual(["failed (Failed): The pull request tracker failed."])
  })

  test("keeps the rows stale when listing the session again fails", () => {
    const script = scripted("listed")
    const seen: string[] = []

    showing(script, (shown) => {
      script.holdLists()
      script.publish(Update.Unreadable({ sessionID: Option.some("a") }))
      script.settle({ failure: "The pull request tracker failed." })
      seen.push(shown())
    })

    expect(seen).toEqual(["stale: listed"])
  })
})

describe("sidebar view after listing again fails", () => {
  test("lists the session again after the next successful renewal, then shows it live", () => {
    const script = scripted("listed")
    const seen: string[] = []

    showing(script, (shown) => {
      script.holdLists()
      script.publish(Update.Unreadable({ sessionID: Option.some("a") }))
      script.settle({ failure: "The pull request tracker failed." })
      jest.advanceTimersByTime(15_000)
      seen.push(shown())
      script.settle({ title: "relisted" })
      seen.push(shown())
    })

    expect(seen).toEqual(["stale: listed", "live: relisted"])
    expect(script.calls.filter((call) => call === "list a")).toHaveLength(3)
  })
})

describe("sidebar view of an unreadable update while stale", () => {
  test("lists the session again straight away, which renews the lease too", () => {
    const script = scripted("listed")
    const seen: string[] = []

    showing(script, (shown) => {
      const look = (): void => {
        seen.push(`${shown()} after ${script.calls.filter((call) => call === "list a").length}`)
      }

      script.renewals("fail")
      jest.advanceTimersByTime(45_000)
      script.holdLists()
      look()
      script.publish(Update.Unreadable({ sessionID: Option.some("a") }))
      look()
      script.settle({ title: "relisted" })
      look()
    })

    expect(seen).toEqual([
      "stale: listed after 1",
      "stale: listed after 2",
      "live: relisted after 2",
    ])
  })
})

describe("sidebar view of an update published while stale", () => {
  test("keeps the view stale, since a published update does not renew the lease", () => {
    const script = scripted("listed")
    const seen: string[] = []

    showing(script, (shown) => {
      script.renewals("fail")
      jest.advanceTimersByTime(45_000)
      script.publish(Update.Published({ view: viewTitled("published") }))
      seen.push(shown())
    })

    expect(seen).toEqual(["stale: published"])
  })
})

describe("sidebar view of updates published while listing again", () => {
  test("clears stale when the listing succeeds, keeping the newer published rows", () => {
    const script = scripted("listed")
    const seen: string[] = []

    showing(script, (shown) => {
      script.holdLists()
      jest.advanceTimersByTime(1000)
      script.publish(Update.Unreadable({ sessionID: Option.some("a") }))

      // Each listing again takes 2 seconds, and a publication arrives 1 second into it.
      for (let cycle = 1; cycle <= 4; cycle += 1) {
        jest.advanceTimersByTime(1000)
        script.publish(Update.Published({ view: viewTitled(`published ${String(cycle)}`) }))
        jest.advanceTimersByTime(1000)
        script.settle({ title: "relisted" })
        jest.advanceTimersByTime(12_998)
        seen.push(shown())
      }
    })

    expect(seen).toEqual([
      "live: published 1",
      "live: published 2",
      "live: published 3",
      "live: published 4",
    ])
  })
})

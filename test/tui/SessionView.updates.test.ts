import { describe, expect, jest, test } from "bun:test"

import { Option } from "effect"

import { Update } from "../../src/tui/Client.ts"
import { scripted, showing } from "../support/sessionView.ts"

describe("sidebar view when an update cannot be read", () => {
  test("shows out of date and lists the session again, then shows it live", () => {
    const script = scripted("listed")
    const seen: string[] = []

    showing(script, (shown) => {
      script.holdLists()
      script.publish(Update.Unreadable({ sessionID: Option.some("a") }))
      seen.push(shown())
      script.settle({ title: "relisted" })
      seen.push(shown())
    })

    expect(seen).toEqual(["out of date: listed", "live: relisted"])
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

    expect(seen).toEqual(["live: listed", "out of date: listed"])
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

    expect(seen).toEqual(["failed: The pull request tracker failed."])
  })

  test("keeps the rows, out of date, when listing the session again fails", () => {
    const script = scripted("listed")
    const seen: string[] = []

    showing(script, (shown) => {
      script.holdLists()
      script.publish(Update.Unreadable({ sessionID: Option.some("a") }))
      script.settle({ failure: "The pull request tracker failed." })
      seen.push(shown())
    })

    expect(seen).toEqual(["out of date: listed"])
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

    expect(seen).toEqual(["out of date: listed", "live: relisted"])
    expect(script.calls.filter((call) => call === "list a")).toHaveLength(3)
  })
})

describe("sidebar view of an unreadable update while not refreshing", () => {
  test("waits for renewals to resume before listing the session again", () => {
    const script = scripted("listed")
    const seen: string[] = []

    showing(script, (shown) => {
      const look = (): void => {
        seen.push(`${shown()} after ${script.calls.filter((call) => call === "list a").length}`)
      }

      script.renewals("fail")
      jest.advanceTimersByTime(45_000)
      script.holdLists()
      script.publish(Update.Unreadable({ sessionID: Option.some("a") }))
      look()
      script.renewals("answer")
      jest.advanceTimersByTime(15_000)
      look()
      script.settle({ title: "relisted" })
      look()
    })

    expect(seen).toEqual([
      "not refreshing: listed after 1",
      "out of date: listed after 2",
      "live: relisted after 2",
    ])
  })
})

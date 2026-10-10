import { describe, expect, jest, test } from "bun:test"

import { Option } from "effect"

import { Update } from "../../src/tui/Client.ts"
import { scripted, showing } from "../support/sessionView.ts"

describe("sidebar view when renewals fail", () => {
  test("shows stale once no renewal has succeeded for 45 seconds, keeping the rows", () => {
    const script = scripted("listed")
    const seen: string[] = []

    showing(script, (shown) => {
      script.renewals("fail")
      jest.advanceTimersByTime(44_999)
      seen.push(shown())
      jest.advanceTimersByTime(1)
      seen.push(shown())
    })

    expect(seen).toEqual(["live: listed", "stale: listed"])
  })

  test("lists the session again when a renewal next succeeds, then shows it live", () => {
    const script = scripted("listed")
    const seen: string[] = []

    showing(script, (shown) => {
      script.renewals("fail")
      jest.advanceTimersByTime(45_000)
      script.renewals("answer")
      script.holdLists()
      jest.advanceTimersByTime(15_000)
      seen.push(shown())
      script.settle({ title: "relisted" })
      seen.push(shown())
    })

    expect(seen).toEqual(["stale: listed", "live: relisted"])
    expect(script.calls.filter((call) => call.startsWith("list"))).toEqual(["list a", "list a"])
  })
})

describe("sidebar view lease timing", () => {
  test("counts the lease from the last successful renewal", () => {
    const script = scripted("listed")
    const seen: string[] = []

    showing(script, (shown) => {
      jest.advanceTimersByTime(15_000)
      script.renewals("fail")
      jest.advanceTimersByTime(44_999)
      seen.push(shown())
      jest.advanceTimersByTime(1)
      seen.push(shown())
    })

    expect(seen).toEqual(["live: listed", "stale: listed"])
  })
})

describe("sidebar view when renewal stops", () => {
  test("shows stale when a defect ends the renewals", () => {
    const script = scripted("listed")
    const seen: string[] = []

    showing(script, (shown) => {
      script.renewals("die")
      jest.advanceTimersByTime(44_999)
      seen.push(shown())
      jest.advanceTimersByTime(1)
      seen.push(shown())
      jest.advanceTimersByTime(60_000)
    })

    expect(seen).toEqual(["live: listed", "stale: listed"])
    expect(script.calls).toEqual(["list a", "watch a"])
  })
})

describe("sidebar view lease renewed by a listing", () => {
  test("counts the lease from a successful listing too", () => {
    const script = scripted("listed")
    const seen: string[] = []

    showing(script, (shown) => {
      script.renewals("fail")
      jest.advanceTimersByTime(30_000)
      script.publish(Update.Unreadable({ sessionID: Option.some("a") }))
      jest.advanceTimersByTime(15_000)
      seen.push(shown())
      jest.advanceTimersByTime(29_999)
      seen.push(shown())
      jest.advanceTimersByTime(1)
      seen.push(shown())
    })

    expect(seen).toEqual(["live: listed", "live: listed", "stale: listed"])
  })
})

import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

test("the TUI bundle uses OpenTUI's reactive Solid transform", async () => {
  const source = await readFile(new URL("../dist/tui.js", import.meta.url), "utf8")

  expect(source).toContain("insertNode as _$insertNode")
  expect(source).toContain("=> items().map")
  expect(source).not.toContain('jsxDEV("box"')
})

test("the package exposes explicit server and TUI entry points", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))

  expect(manifest.exports).toEqual({
    "./server": { import: "./dist/server.js" },
    "./tui": { import: "./dist/tui.js" },
  })
})

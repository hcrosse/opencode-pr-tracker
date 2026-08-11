import { beforeAll, expect, test } from "bun:test"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const distribution = new URL("../dist/", import.meta.url)

beforeAll(async () => {
  await mkdir(distribution, { recursive: true })
  await writeFile(new URL("stale.js", distribution), "stale\n")

  const build = Bun.spawn(["bun", "run", "--silent", "build"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdout: "ignore",
    stderr: "pipe",
  })
  const [exitCode, stderr] = await Promise.all([build.exited, new Response(build.stderr).text()])
  expect(stderr).toBe("")
  expect(exitCode).toBe(0)
})

test("the build replaces the distribution directory", async () => {
  expect(new Set(await readdir(distribution))).toEqual(new Set(["server.js", "server.js.map", "tui.js", "tui.js.map"]))
})

test("the TUI bundle uses OpenTUI's reactive Solid transform", async () => {
  const source = await readFile(new URL("../dist/tui.js", import.meta.url), "utf8")

  expect(source).toContain("insertNode as _$insertNode")
  expect(source).toContain("=> items().map")
  expect(source).not.toContain('jsxDEV("box"')
})

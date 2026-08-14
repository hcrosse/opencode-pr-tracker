import solidPlugin from "@opentui/solid/bun-plugin"
import { rm } from "node:fs/promises"

const outdir = "./dist"
await rm(outdir, { recursive: true, force: true })

const result = await Bun.build({
  entrypoints: ["./src/server.ts", "./src/tui.tsx"],
  outdir,
  target: "bun",
  format: "esm",
  sourcemap: "external",
  external: [
    "@opencode-ai/plugin",
    "@opencode-ai/plugin/tui",
    "@opentui/core",
    "@opentui/keymap/solid",
    "@opentui/solid",
    "solid-js",
  ],
  plugins: [solidPlugin],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  throw new Error("Failed to build OpenCode PR Tracker")
}

for (const output of result.outputs) {
  console.log(`${output.path} ${output.size} bytes`)
}

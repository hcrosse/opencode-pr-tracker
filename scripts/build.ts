import { rm } from "node:fs/promises"

import solidPlugin from "@opentui/solid/bun-plugin"

const outdir = "./dist"

await rm(outdir, { force: true, recursive: true })

const result = await Bun.build({
  entrypoints: ["./src/server.ts"],
  external: [
    "@opencode/plugin",
    "@opentui/core",
    "@opentui/solid",
    "solid-js",
    "effect",
    "@effect/platform-node",
  ],
  format: "esm",
  outdir,
  plugins: [solidPlugin],
  sourcemap: "external",
  target: "bun",
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  throw new Error("Failed to build OpenCode PR Tracker")
}

for (const output of result.outputs) console.log(`${output.path} ${output.size} bytes`)

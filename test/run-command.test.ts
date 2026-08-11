import { expect, test } from "bun:test"

import { runCommand } from "../scripts/run-command.js"

test("returns stdout when the command completes within its timeout", async () => {
  const stdout = await runCommand(process.execPath, ["-e", 'process.stdout.write("complete\\n")'], {
    label: "quick stage",
    timeoutMs: 1_000,
  })

  expect(stdout).toBe("complete")
})

test("terminates a timed-out command and reports its stage and output", async () => {
  const command = [
    'process.stdout.write("partial stdout\\n")',
    'process.stderr.write("partial stderr\\n")',
    "setInterval(() => undefined, 1_000)",
  ].join(";")

  let failure: unknown
  try {
    await runCommand(process.execPath, ["-e", command], { label: "hanging stage", timeoutMs: 100 })
  } catch (error) {
    failure = error
  }

  expect(failure).toBeInstanceOf(Error)
  if (!(failure instanceof Error)) throw new Error("expected command failure")
  expect(failure.message).toContain("hanging stage timed out after 0.1s")
  expect(failure.message).toContain("partial stdout")
  expect(failure.message).toContain("partial stderr")
})

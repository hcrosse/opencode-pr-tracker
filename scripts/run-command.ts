export type RunCommandOptions = Readonly<{
  cwd?: string
  env?: NodeJS.ProcessEnv
  label?: string
  timeoutMs?: number
}>

const defaultTimeoutMs = 60_000
const terminationGraceMs = 5_000

function isMissingProcess(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH"
}

export async function runCommand(
  command: string,
  args: readonly string[],
  options: RunCommandOptions = {},
): Promise<string> {
  const label = options.label ?? command
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
  const startedAt = performance.now()
  console.log(`[smoke] ${label} started`)
  const useProcessGroup = process.platform !== "win32"
  const child = Bun.spawn([command, ...args], {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
    detached: useProcessGroup,
    stdout: "pipe",
    stderr: "pipe",
  })

  function terminate(signal: NodeJS.Signals): void {
    if (!useProcessGroup) {
      child.kill(signal)
      return
    }
    try {
      process.kill(-child.pid, signal)
    } catch (error) {
      if (!isMissingProcess(error)) throw error
    }
  }

  const completion: Promise<[number, string, string]> = Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutReached = new Promise<"timed-out">((resolveTimeout) => {
    timeout = setTimeout(() => resolveTimeout("timed-out"), timeoutMs)
  })

  let outcome: Awaited<typeof completion> | "timed-out"
  try {
    outcome = await Promise.race([completion, timeoutReached])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }

  let timedOut = false
  if (outcome === "timed-out") {
    timedOut = true
    terminate("SIGTERM")
    let forceKill: ReturnType<typeof setTimeout> | undefined
    const graceElapsed = new Promise<false>((resolveGrace) => {
      forceKill = setTimeout(() => resolveGrace(false), terminationGraceMs)
    })
    let stopped: Awaited<typeof completion> | false
    try {
      stopped = await Promise.race([completion, graceElapsed])
    } finally {
      if (forceKill !== undefined) clearTimeout(forceKill)
    }
    if (stopped === false) terminate("SIGKILL")
    outcome = await completion
  }

  const [exitCode, stdout, stderr] = outcome
  if (timedOut) {
    throw new Error(
      [
        `${label} timed out after ${(timeoutMs / 1_000).toFixed(1)}s: ${command} ${args.join(" ")}`,
        stdout,
        stderr,
      ].join("\n"),
    )
  }
  if (exitCode !== 0) {
    throw new Error([`Command failed (${exitCode}): ${command} ${args.join(" ")}`, stdout, stderr].join("\n"))
  }
  console.log(`[smoke] ${label} completed in ${((performance.now() - startedAt) / 1000).toFixed(1)}s`)
  return stdout.trim()
}

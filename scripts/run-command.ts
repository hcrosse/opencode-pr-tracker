export type RunCommandOptions = Readonly<{
  cwd?: string
  env?: NodeJS.ProcessEnv
  label?: string
  timeoutMs?: number
}>

const defaultTimeoutMs = 60_000
const terminationGraceMs = 5_000

export async function runCommand(
  command: string,
  args: readonly string[],
  options: RunCommandOptions = {},
): Promise<string> {
  const label = options.label ?? command
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
  const startedAt = performance.now()
  console.log(`[smoke] ${label} started`)
  const child = Bun.spawn([command, ...args], {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
    stdout: "pipe",
    stderr: "pipe",
  })

  let timedOut = false
  let forceKill: ReturnType<typeof setTimeout> | undefined
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill("SIGTERM")
    forceKill = setTimeout(() => child.kill("SIGKILL"), terminationGraceMs)
  }, timeoutMs)

  let exitCode: number
  let stdout: string
  let stderr: string
  try {
    ;[exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
  } finally {
    clearTimeout(timeout)
    if (forceKill !== undefined) clearTimeout(forceKill)
  }

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

export function casesHandled(value: never): never {
  throw new Error(`Unhandled case: ${String(value)}`)
}

import { USAGE } from '../constants'

export const error = (error: unknown): string => {
  return `Error: ${error instanceof Error ? error.message : String(error)}`
}

export function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

export const print_usage = ({
  exit,
  message,
  logger,
}: {
  exit?: number
  message?: string
  logger?: Console['log'] | Console['error']
} = {}) => {
  const isError = exit !== undefined && exit !== 0
  const output = !logger && isError ? console.error : console.log
  if (message) output(message)
  output(USAGE)
  if (exit !== undefined) process.exit(exit)
}

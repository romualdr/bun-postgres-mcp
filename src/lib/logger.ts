export const logger = (namespace?: string) => {
  const file = Bun.file(`./debug.${namespace || 'general'}.log`)
  const log = (level: string, m: string) => {
    const timestamp = new Date().toISOString()
    const start = [timestamp, namespace, level.toUpperCase()].filter(Boolean)
    const message = `[${start.join('] [')}] ${m}`
    console.error(message)
  }
  return {
    log: (message: string) => log('log', message),
    error: (message: string) => log('error', message),
    debug: (message: string) => log('debug', message),
    info: (message: string) => log('info', message),
    warn: (message: string) => log('warn', message),
  }
}

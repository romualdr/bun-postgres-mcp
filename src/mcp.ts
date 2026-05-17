import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server'
import { AccessMode, type RegisterCommand } from './constants'
import { get_parameters } from './lib/args'
import { logger as Logger } from './lib/logger'
import { print_usage } from './lib/utils'
import { SQL } from './sql'
import { obfuscatePassword } from './sql/driver'

const l = Logger()
const sql = new SQL()
const mcp = new McpServer({
  name: 'postgres-mcp',
  version: '1.0.0',
})

const commands: RegisterCommand[] = await Promise.all([
  import('./commands/analyze_db_health.ts').then((m) => m.register),
  import('./commands/execute_sql.ts').then((m) => m.register),
  import('./commands/explain_query.ts').then((m) => m.register),
  import('./commands/get_object_details.ts').then((m) => m.register),
  import('./commands/get_top_queries.ts').then((m) => m.register),
  import('./commands/list_objects.ts').then((m) => m.register),
  import('./commands/list_schemas.ts').then((m) => m.register),
])

export const run = async () => {
  const args = get_parameters()
  const anon = args.anonymize

  // connect to database
  try {
    await sql.connect(args.dburi)
    l.info('Successfully connected to database')
  } catch (err) {
    l.error(`Can't connect to database: ${obfuscatePassword(String(err))}`)
    print_usage({
      exit: 1,
      message: 'Failed to connect to database. Check DATABASE_URL.',
    })
  }

  // Mode & tools
  sql.setMode(args.restricted ? AccessMode.RESTRICTED : AccessMode.UNRESTRICTED)
  l.info(`Running ${args.mode} ${anon ? 'with' : 'w/o'} anonymization.`)
  await Promise.all(commands.map((register) => register(args, mcp, sql)))
  l.info(`Registered ${commands.length} command(s).`)

  // process signals for graceful shutdown
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  const transport = new StdioServerTransport()
  await mcp.connect(transport)
}

async function shutdown() {
  try {
    await sql.close()
  } catch {}
  process.exit(0)
}

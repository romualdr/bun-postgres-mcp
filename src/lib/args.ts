import { parseArgs } from 'util'
import { AccessMode } from '../constants'
import { print_usage } from './utils'

const args = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    help: {
      type: 'boolean',
      short: 'h',
    },
    mode: {
      type: 'string',
      choices: [AccessMode.RESTRICTED, AccessMode.UNRESTRICTED],
      default: AccessMode.RESTRICTED,
    },
    anonymize: { type: 'boolean', default: false },
    ssl: { type: 'boolean', default: false },
  },
})

export const get_parameters = () => {
  const params = {
    ...args.values,
    dburi: args.positionals[0] || process.env.DATABASE_URL || '',
    get restricted() {
      return args.values.mode === AccessMode.RESTRICTED
    },
  }

  if (params.help) {
    return print_usage({
      exit: 0,
      logger: console.log,
    }) as never
  }

  if (params.ssl && !params.dburi.includes('?')) {
    params['dburi'] += '?sslmode=require'
  } else if (params.ssl) {
    params['dburi'] += '&sslmode=require'
  }

  return params
}

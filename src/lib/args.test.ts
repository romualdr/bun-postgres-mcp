import { test, expect, spyOn, beforeEach, afterEach } from 'bun:test'
import { AccessMode } from '../constants'
import { get_parameters } from './args'

test('defaults: restricted mode, no anonymize, no ssl', () => {
  const params = get_parameters(['postgres://localhost/db'])
  expect(params.mode).toBe(AccessMode.RESTRICTED)
  expect(params.restricted).toBe(true)
  expect(params.anonymize).toBe(false)
  expect(params.ssl).toBe(false)
  expect(params.dburi).toBe('postgres://localhost/db')
})

test('reads DATABASE_URL when no positional is given', () => {
  process.env.DATABASE_URL = 'postgres://env/db'
  const params = get_parameters([])
  expect(params.dburi).toBe('postgres://env/db')
  delete process.env.DATABASE_URL
})

test('positional takes precedence over DATABASE_URL', () => {
  process.env.DATABASE_URL = 'postgres://env/db'
  const params = get_parameters(['postgres://arg/db'])
  expect(params.dburi).toBe('postgres://arg/db')
  delete process.env.DATABASE_URL
})

test('--mode unrestricted sets restricted to false', () => {
  const params = get_parameters(['--mode', 'unrestricted', 'postgres://localhost/db'])
  expect(params.mode).toBe(AccessMode.UNRESTRICTED)
  expect(params.restricted).toBe(false)
})

test('--anonymize enables anonymization', () => {
  const params = get_parameters(['--anonymize', 'postgres://localhost/db'])
  expect(params.anonymize).toBe(true)
})

test('--ssl appends sslmode=require to a plain URL', () => {
  const params = get_parameters(['--ssl', 'postgres://localhost/db'])
  expect(params.dburi).toBe('postgres://localhost/db?sslmode=require')
})

test('--ssl appends sslmode=require to a URL that already has query params', () => {
  const params = get_parameters(['--ssl', 'postgres://localhost/db?connect_timeout=10'])
  expect(params.dburi).toBe('postgres://localhost/db?connect_timeout=10&sslmode=require')
})

test('--help exits with code 0', () => {
  const exit = spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })
  expect(() => get_parameters(['--help'])).toThrow('exit')
  expect(exit).toHaveBeenCalledWith(0)
  exit.mockRestore()
})

test('-h is an alias for --help', () => {
  const exit = spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })
  expect(() => get_parameters(['-h'])).toThrow('exit')
  expect(exit).toHaveBeenCalledWith(0)
  exit.mockRestore()
})

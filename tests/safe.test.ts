import { describe, expect, test } from 'bun:test'
import { validate } from '../src/sql/safe'

describe('validate — allowed queries', () => {
  test('allows SELECT', () => expect(() => validate('SELECT 1')).not.toThrow())
  test('allows SELECT with whitespace', () => expect(() => validate('  SELECT * FROM users')).not.toThrow())
  test('allows SHOW', () => expect(() => validate('SHOW server_version')).not.toThrow())
  test('allows EXPLAIN', () => expect(() => validate('EXPLAIN SELECT * FROM users')).not.toThrow())
  test('allows VACUUM', () => expect(() => validate('VACUUM users')).not.toThrow())
  test('allows ANALYZE', () => expect(() => validate('ANALYZE users')).not.toThrow())
  test('allows CREATE EXTENSION', () =>
    expect(() => validate('CREATE EXTENSION pg_stat_statements')).not.toThrow())
  test('allows WITH (CTE)', () =>
    expect(() => validate('WITH t AS (SELECT 1) SELECT * FROM t')).not.toThrow())
  test('allows DECLARE cursor', () => expect(() => validate('DECLARE cur CURSOR FOR SELECT 1')).not.toThrow())
  test('allows FETCH cursor', () => expect(() => validate('FETCH NEXT FROM cur')).not.toThrow())
})

describe('validate — forbidden queries', () => {
  test('rejects INSERT', () =>
    expect(() => validate('INSERT INTO users VALUES (1)')).toThrow())

  test('rejects UPDATE', () =>
    expect(() => validate("UPDATE users SET name = 'x' WHERE id = 1")).toThrow())

  test('rejects DELETE', () =>
    expect(() => validate('DELETE FROM users WHERE id = 1')).toThrow())

  test('rejects DROP TABLE', () =>
    expect(() => validate('DROP TABLE users')).toThrow())

  test('rejects ALTER TABLE', () =>
    expect(() => validate('ALTER TABLE users ADD COLUMN x int')).toThrow())

  test('rejects TRUNCATE', () =>
    expect(() => validate('TRUNCATE users')).toThrow())

  test('rejects GRANT', () =>
    expect(() => validate('GRANT SELECT ON users TO app')).toThrow())

  test('rejects REVOKE', () =>
    expect(() => validate('REVOKE SELECT ON users FROM app')).toThrow())

  test('rejects CREATE TABLE (but not CREATE EXTENSION)', () =>
    expect(() => validate('CREATE TABLE users (id int)')).toThrow())
})

describe('validate — comment stripping', () => {
  test('strips line comment before checking prefix', () =>
    expect(() => validate('-- DROP TABLE users\nSELECT 1')).not.toThrow())

  test('strips block comment before checking prefix', () =>
    expect(() => validate('/* DROP TABLE users */ SELECT 1')).not.toThrow())

  test('still rejects DROP after stripping an unrelated comment', () =>
    expect(() => validate('/* safe */ DROP TABLE users')).toThrow())
})

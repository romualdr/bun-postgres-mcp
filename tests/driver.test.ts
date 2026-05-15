import { describe, expect, test } from 'bun:test'
import { obfuscatePassword } from '../src/sql/driver'

describe('obfuscatePassword', () => {
  test('returns null unchanged', () => expect(obfuscatePassword(null)).toBeNull())
  test('returns undefined unchanged', () => expect(obfuscatePassword(undefined)).toBeUndefined())
  test('returns empty string unchanged', () => expect(obfuscatePassword('')).toBe(''))

  test('redacts password in postgres:// URL', () =>
    expect(obfuscatePassword('postgres://user:secret@localhost/db')).toBe(
      'postgres://user:****@localhost/db',
    ))

  test('redacts password in postgresql:// URL', () =>
    expect(obfuscatePassword('postgresql://admin:p@ssw0rd@db.example.com/mydb')).toBe(
      'postgresql://admin:****@db.example.com/mydb',
    ))

  test('redacts password= key in connection string', () =>
    expect(obfuscatePassword('host=localhost password=secret user=admin')).toBe(
      'host=localhost password=**** user=admin',
    ))

  test('redacts password= with single-quoted value', () =>
    expect(obfuscatePassword("password='my secret'")).toBe("password='****'"))

  test('leaves string without password unchanged', () => {
    const s = 'host=localhost user=admin dbname=mydb'
    expect(obfuscatePassword(s)).toBe(s)
  })
})

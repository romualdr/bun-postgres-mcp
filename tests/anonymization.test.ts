import { describe, expect, test } from 'bun:test'
import {
  REDACTED,
  anonymizeRow,
  anonymizeRows,
  shouldRedact,
} from '../src/lib/anonymization'

describe('shouldRedact — keyword field names', () => {
  test('redacts password', () => expect(shouldRedact('password', 'abc')).toBe(true))
  test('redacts email', () => expect(shouldRedact('email', 'u@x.com')).toBe(true))
  test('redacts first_name', () => expect(shouldRedact('first_name', 'Alice')).toBe(true))
  test('redacts last_name', () => expect(shouldRedact('last_name', 'Smith')).toBe(true))
  test('redacts account_number', () => expect(shouldRedact('account_number', '1234')).toBe(true))
  test('redacts api_key', () => expect(shouldRedact('api_key', 'key')).toBe(true))
  test('redacts access_token', () => expect(shouldRedact('access_token', 'tok')).toBe(true))
  test('redacts secret', () => expect(shouldRedact('secret', 'shhh')).toBe(true))
  test('is case-insensitive on field name', () =>
    expect(shouldRedact('EMAIL', 'u@x.com')).toBe(true))
})

describe('shouldRedact — keyword substring matching', () => {
  test('redacts business_email', () => expect(shouldRedact('business_email', 'foo')).toBe(true))
  test('redacts user_phone_number', () => expect(shouldRedact('user_phone_number', '123')).toBe(true))
  test('redacts hashed_password', () => expect(shouldRedact('hashed_password', 'x')).toBe(true))
  test('redacts private_key', () => expect(shouldRedact('private_key', 'x')).toBe(true))
  test('redacts user_address', () => expect(shouldRedact('user_address', 'x')).toBe(true))
  test('redacts reset_token', () => expect(shouldRedact('reset_token', 'x')).toBe(true))
  test('redacts photo_s3_url', () =>
    expect(shouldRedact('photo_s3_url', 'https://s3.example.com/img')).toBe(true))
  test('does not redact redirect_url', () =>
    expect(shouldRedact('redirect_url', 'https://example.com')).toBe(false))
})

describe('shouldRedact — safe fields', () => {
  test('does not redact id', () => expect(shouldRedact('id', '42')).toBe(false))
  test('does not redact user_id', () => expect(shouldRedact('user_id', '42')).toBe(false))
  test('does not redact status', () => expect(shouldRedact('status', 'active')).toBe(false))
  test('redacts email field regardless of null value', () => expect(shouldRedact('email', null)).toBe(true))
  test('does not redact empty string by value analyzers', () =>
    expect(shouldRedact('status', '')).toBe(false))
})

describe('shouldRedact — JSON value PII key detection', () => {
  test('redacts JSON object containing email key', () =>
    expect(shouldRedact('metadata', JSON.stringify({ email: 'foo@bar.com', status: 'active' }))).toBe(true))

  test('redacts JSON object with nested PII key', () =>
    expect(shouldRedact('data', JSON.stringify({ user: { first_name: 'Alice' } }))).toBe(true))

  test('redacts JSON array of objects with PII key', () =>
    expect(shouldRedact('contacts', JSON.stringify([{ phone: '123', label: 'work' }]))).toBe(true))

  test('does not redact JSON with no PII keys', () =>
    expect(shouldRedact('config', JSON.stringify({ status: 'active', count: 5 }))).toBe(false))

  test('does not redact non-JSON string on safe field', () =>
    expect(shouldRedact('description', 'just some text')).toBe(false))
})

describe('shouldRedact — value analyzers', () => {
  test('redacts email address value', () =>
    expect(shouldRedact('data', 'user@example.com')).toBe(true))

  test('redacts JWT token value', () =>
    expect(
      shouldRedact('data', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'),
    ).toBe(true))

  test('redacts IBAN value', () =>
    expect(shouldRedact('data', 'FR7614508711001906946936763')).toBe(true))

  test('redacts bcrypt hash', () =>
    expect(
      shouldRedact('data', '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234'),
    ).toBe(true))

  test('redacts IPv4 address', () =>
    expect(shouldRedact('data', '192.168.1.1')).toBe(true))

  test('redacts IPv4 with CIDR', () =>
    expect(shouldRedact('data', '10.0.0.0/8')).toBe(true))

  test('redacts international phone number', () =>
    expect(shouldRedact('data', '+33612345678')).toBe(true))

  test('redacts 32-char hex secret', () =>
    expect(shouldRedact('data', 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4')).toBe(true))

  test('redacts long base64url token', () =>
    expect(
      shouldRedact('data', 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwx'),
    ).toBe(true))

  test('does not redact short plain text', () =>
    expect(shouldRedact('data', 'hello')).toBe(false))

  test('does not redact numeric ID string', () =>
    expect(shouldRedact('data', '12345')).toBe(false))
})

describe('shouldRedact — value analyzers (pattern gaps)', () => {
  test('redacts single-char TLD email (a@b.c)', () =>
    expect(shouldRedact('data', 'a@b.c')).toBe(true))

  test('redacts scrypt passlib hash (scrypt:N:r:p$ format)', () =>
    expect(shouldRedact('data', 'scrypt:32768:8:1$PPJyZVTUskSdBWUm$9cfd783758a08f34abcd1234')).toBe(true))

  test('redacts Visa card number (Luhn-valid)', () =>
    expect(shouldRedact('data', '4111111111111111')).toBe(true))

  test('redacts card number with spaces', () =>
    expect(shouldRedact('data', '4111 1111 1111 1111')).toBe(true))

  test('does not redact random 16-digit number (Luhn-invalid)', () =>
    expect(shouldRedact('data', '1234567890123456')).toBe(false))
})

describe('anonymizeRow', () => {
  test('replaces sensitive fields with REDACTED', () => {
    const result = anonymizeRow({ id: 1, email: 'u@x.com', status: 'active' })
    expect(result).toEqual({ id: 1, email: REDACTED, status: 'active' })
  })

  test('replaces payload field by name', () => {
    const result = anonymizeRow({ payload: 'user@example.com' })
    expect(result['payload']).toBe(REDACTED)
  })

  test('redacts non-obvious field with JSON containing PII key', () => {
    const result = anonymizeRow({ metadata: JSON.stringify({ email: 'x@y.com' }) })
    expect(result['metadata']).toBe(REDACTED)
  })

  test('keeps null values on non-obvious fields', () => {
    const result = anonymizeRow({ score: null })
    expect(result['score']).toBeNull()
  })
})

describe('anonymizeRows', () => {
  test('processes multiple rows', () => {
    const rows = [
      { id: 1, email: 'a@b.com' },
      { id: 2, email: 'c@d.com' },
    ]
    const result = anonymizeRows(rows)
    expect(result[0]).toEqual({ id: 1, email: REDACTED })
    expect(result[1]).toEqual({ id: 2, email: REDACTED })
  })

  test('returns empty array for empty input', () => {
    expect(anonymizeRows([])).toEqual([])
  })
})

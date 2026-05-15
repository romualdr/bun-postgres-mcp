export const REDACTED = '<redacted>'

// A field name is PII if its lowercased form contains any of these keywords.
// Covers column variants like "business_email", "user_phone_number", "hashed_password", etc.
export const PII_KEYWORDS: string[] = [
  // Personal names
  'first_name', 'last_name', 'firstname', 'lastname',
  'given_name', 'family_name', 'full_name', 'maiden_name',

  // Dates & demographics
  'birth_date', 'birthdate', 'date_of_birth', 'dob',
  'birth_place', 'birthplace',
  'nationality',

  // Contact
  'email',
  'phone',
  'address',
  'postal_code', 'postcode',

  // Government & financial identifiers
  'ssn',
  'passport',
  'national_id',
  'tax_id',
  'account_number',
  'iban',
  'card_number',

  // Credentials & secrets
  'password', 'passwd', 'pwd',
  'secret',
  'token',
  'api_key', 'key',
  'hash',
  'salt',
  'vault',

  // Network identifiers
  'ip_address', 'ip_addr',

  // Opaque payloads & private storage
  'payload',
  's3_url',
]

export function fieldNameIsPii(fieldName: string): boolean {
  const lower = fieldName.toLowerCase()
  return PII_KEYWORDS.some(kw => lower.includes(kw))
}

// If a string value parses as JSON and any key (at any depth) is a PII field name, redact it.
function jsonContainsPiiKey(value: string): boolean {
  if (value[0] !== '{' && value[0] !== '[') return false
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { return false }
  return objectHasPiiKey(parsed)
}

function objectHasPiiKey(val: unknown): boolean {
  if (Array.isArray(val)) return val.some(item => objectHasPiiKey(item))
  if (val !== null && typeof val === 'object') {
    for (const [k, child] of Object.entries(val as Record<string, unknown>)) {
      if (fieldNameIsPii(k)) return true
      if (objectHasPiiKey(child)) return true
    }
  }
  return false
}

// Value pattern analyzers — called only when the field name is not already PII.
const ANALYZERS: Array<(value: string) => boolean> = [
  // Email address (TLD can be 1+ chars to cover a@b.c)
  (v) => /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{1,}$/.test(v),

  // JWT: three base64url segments separated by dots
  (v) => /^eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]*$/.test(v),

  // IBAN: 2-letter country code + 2 digits + up to 30 alphanumeric
  (v) => /^[A-Z]{2}\d{2}[A-Z0-9]{4,30}$/.test(v.replace(/\s/g, '')),

  // Password hash (bcrypt, argon2id, argon2i, scrypt/$scrypt$, scrypt:N:r:p$ passlib, sha-crypt)
  (v) => /^(\$2[abxy]\$\d+\$|\$argon2[id]+\$|\$scrypt\$|scrypt:\d+:\d+:\d+\$|\{S?SHA\d*\}[A-Za-z0-9+/=]{20,})/.test(v),

  // IPv4 with optional CIDR notation
  (v) => /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(v),

  // IPv6 (simplified: contains at least two colons)
  (v) => v.includes(':') && /^[0-9a-fA-F:]{5,}$/.test(v),

  // International phone number: starts with +, 8–15 digits
  (v) =>
    /^\+[1-9]\d{7,14}$/.test(v.replace(/[\s\-().]/g, '')) &&
    v.replace(/[\s\-().]/g, '').length <= 16,

  // Hex secret (API key / token): 32+ lowercase hex chars with no spaces
  (v) => /^[0-9a-f]{32,}$/.test(v),

  // High-entropy base64url string: 40+ chars (API keys, bearer tokens)
  (v) => v.length >= 40 && /^[A-Za-z0-9\-_+/]{40,}={0,2}$/.test(v),

  // Credit card number: 13-19 digits (with optional spaces/dashes), Luhn-valid
  (v) => {
    const digits = v.replace(/[\s\-]/g, '')
    if (!/^\d{13,19}$/.test(digits)) return false
    let sum = 0
    let alt = false
    for (let i = digits.length - 1; i >= 0; i--) {
      let n = parseInt(digits[i]!, 10)
      if (alt) { n *= 2; if (n > 9) n -= 9 }
      sum += n
      alt = !alt
    }
    return sum % 10 === 0
  },
]

export function shouldRedact(fieldName: string, value: unknown): boolean {
  if (fieldNameIsPii(fieldName)) return true

  if (typeof value !== 'string' || value.length === 0) return false

  if (jsonContainsPiiKey(value)) return true

  return ANALYZERS.some((fn) => fn(value))
}

export function anonymizeRow(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    out[k] = shouldRedact(k, v) ? REDACTED : v
  }
  return out
}

export function anonymizeRows(
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  return rows.map(anonymizeRow)
}

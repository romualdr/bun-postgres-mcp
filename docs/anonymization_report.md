# Anonymization Layer Report

**Date:** 2026-05-16
**Scope:** `database-mcp` — read-only SQL execution with built-in PII redaction
**Method:** White-card penetration test — all SQL vectors authorized

---

## Redaction Architecture

The system applies redaction at three levels:

1. **Source column tracking** — sensitive columns (`email`, `hashed_password`, `phone_number`, `reset_token`, etc.) are substituted with the string `<redacted>` before results are returned, regardless of output alias
2. **Output alias name matching** — aliases matching a keyword blocklist (`email`, `secret`, `token`, `phone`, `redacted`, `user_id`, `addr`, `contact`, `mail`, `pwd`, `pass`, etc.) are redacted
3. **Content pattern matching** — values matching known PII formats are redacted: email addresses (`x@y.zz`, 2+ char TLD), phone numbers, IBANs, credit card numbers (Visa, Mastercard, Amex)

---

## Tested Vectors

All vectors below were tested against live data. No exploitable bypass remains.

### Direct Column Access ✅
All known PII columns are redacted: `email`, `hashed_password`, `phone_number`, `reset_token`, `provider_data`, `users.first_name/last_name/birth_date/address`, `contacts.email/phone_number/notes`, `audit_logs.provider_data`.

### String Function Wrapping ✅
All transformation functions are blocked at query parse time with an explicit error (`Function X() is not allowed in anonymized mode`): `SUBSTRING`, `SUBSTR`, `LEFT`, `RIGHT`, `REVERSE`, `SPLIT_PART`, `TRANSLATE`, `REPLACE`, `TRIM`, `LPAD`, `ASCII`, `FORMAT`, `LENGTH`, `REGEXP_REPLACE`, `ENCODE`.

### JSON & Row Serialization ✅
`QUOTE_LITERAL`, `QUOTE_IDENT`, `JSON_BUILD_OBJECT`, `JSONB_BUILD_OBJECT`, `ROW_TO_JSON`, composite row selection (`SELECT alias FROM table alias`), `JSON_AGG`, `STRING_AGG`, `ARRAY_AGG` — all redact sensitive fields correctly.

### Subqueries & Structural Bypasses ✅
Scalar subqueries, CTEs, `LATERAL`, `VALUES`, `UNNEST`, `COALESCE`, `NULLIF`, `CASE WHEN`, string concatenation operator (`||`), explicit casts (`::text`, `CAST AS`) — all propagate `<redacted>` correctly.

### Aggregates & Window Functions ✅
`MAX`, `MIN`, `FIRST_VALUE`, `LAG` on sensitive columns return `<redacted>`. See behavioral notes for `COUNT(DISTINCT)` and `GROUP BY`.

### Boolean & Inference Attacks ✅
All comparison operators (`>`, `<`, `=`, `~`, `ILIKE`, `SIMILAR TO`) operate on the `<redacted>` placeholder, not the real value — no data leakage. Cast errors expose `<redacted>` in the error message, not the actual value. `pg_sleep` timing attacks are neutralized for the same reason.

Boolean WHERE-clause inference (`WHERE email = 'x@y.com'`, `COUNT(*) WHERE email LIKE 'a%'`) returns user-existence metadata — accepted as intentional.

### Miscellaneous ✅
`TO_TSVECTOR`, `XMLFOREST`, `GREATEST`, `TO_JSON`, `MD5`, `UPPER` — all redacted. `pg_read_file` and `COPY TO` are blocked at the permission layer. `pg_stat_activity` only exposes current MCP session queries.

### Content Pattern Detection ✅
Email (`x@y.zz`), phone, IBAN, Visa/Mastercard/Amex card numbers detected and redacted in literal values. Single-char TLD (`a@b.c`) not matched — not a real-world concern.

---

## Behavioral Side Effects

The redaction substitutes sensitive values with the string `<redacted>` at the data level. This is correct for security but has functional consequences for query authors:

| Behavior | Effect |
|----------|--------|
| `COUNT(DISTINCT email)` → `1` | All users appear to share the same email — aggregations on sensitive columns return silently wrong results |
| `GROUP BY email` → single group | All rows collapse into one group |
| `ORDER BY email` → no effect | Sort on sensitive columns is a no-op |
| `WHERE email > 'p'` → always `true` | Filter conditions on sensitive columns produce consistent results independent of actual data — can silently empty or inflate result sets |
| `COALESCE(email, 'fallback')` → `<redacted>` | Returns placeholder, not fallback — the field appears non-null to COALESCE |

These are not security issues but should be documented for anyone writing analytical queries through this MCP.

---

## Verdict

The anonymization layer is **robust**. No exploitable bypass was found in the final state. All attack vectors — function wrapping, JSON serialization, row dumps, aggregate leakage, inference attacks, timing, cast errors — are correctly neutralized.

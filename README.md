# bun-postgres-mcp

Give your AI assistant direct, safe access to your PostgreSQL database — query data, inspect schemas, analyze performance, and explore your database structure, all from within your AI tool of choice.

- **Zero configuration** — point it at a connection string and go, no schema files or mappings needed
- **Safe by default** — read-only restricted mode prevents accidental writes
- **Built-in PII protection** — `--anonymize` masks sensitive columns at the query level before results are returned, with a [pentested anonymization layer](docs/anonymization_report.md)
- **Self-describing** — the AI can explore your database structure on its own via schema and object inspection tools
- **Performance tooling included** — surface slow queries and run health checks (indexes, connections, vacuum, replication) without leaving your AI tool

## Usage

Add `bun-postgres-mcp` to your AI tool's MCP configuration. No global install needed — `bunx` runs it directly.

**Claude Code** (`~/.claude/settings.json` or `~/.claude.json`):

```json
{
  "mcpServers": {
    "postgres": {
      "command": "bunx",
      "args": ["bun-postgres-mcp", "postgres://user:pass@localhost:5432/mydb"]
    }
  }
}
```

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "postgres": {
      "command": "bunx",
      "args": ["bun-postgres-mcp", "postgres://user:pass@localhost:5432/mydb"]
    }
  }
}
```

**Cursor** (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "postgres": {
      "command": "bunx",
      "args": ["bun-postgres-mcp", "postgres://user:pass@localhost:5432/mydb"]
    }
  }
}
```

The connection string can also be passed via the `DATABASE_URL` environment variable instead of as an argument.

---

## Options

| Flag                              | Default      | Description                                                                           |
| --------------------------------- | ------------ | ------------------------------------------------------------------------------------- |
| `-h, --help`                      |              | Prints usage information and exits.                                                   |
| `--mode restricted\|unrestricted` | `restricted` | `restricted` limits `execute_sql` to read-only queries. `unrestricted` allows writes. |
| `--anonymize`                     | off          | Redacts PII fields in `execute_sql` results (see [Anonymization](#anonymization)).    |
| `--ssl`                           | off          | Appends `sslmode=require` to the connection string.                                   |

**Example with options:**

```json
"args": ["bun-postgres-mcp", "--anonymize", "--ssl", "postgres://user:pass@host:5432/mydb"]
```

---

## MCP Tools

| Tool                 | Description                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| `execute_sql`        | Executes a SQL query. Read-only in restricted mode. Redacts sensitive fields when `--anonymize` is set. |
| `explain_query`      | Returns the execution plan for a query. Pass `analyze: true` to run it and get real statistics.         |
| `list_schemas`       | Lists all schemas in the database.                                                                      |
| `list_objects`       | Lists tables, sequences, and extensions in a given schema.                                              |
| `get_object_details` | Returns detailed info about a database object (columns, indexes, constraints, etc.).                    |
| `get_top_queries`    | Reports slowest or most resource-intensive queries via `pg_stat_statements`.                            |
| `analyze_db_health`  | Runs health checks: indexes, connections, vacuum, sequences, replication, buffer cache, constraints.    |

---

## Anonymization

When `--anonymize` is enabled, sensitive values in `execute_sql` results are replaced with the string `<redacted>`. Redaction operates at three levels:

1. **Source columns** — known PII columns (`email`, `phone_number`, `hashed_secret`, `reset_token`, etc.) are always redacted.
2. **Output alias matching** — aliases matching PII keywords (`email`, `token`, `phone`, `secret`, `pass`, etc.) are redacted.
3. **Content pattern detection** — values that look like emails, phone numbers, IBANs, or credit card numbers are redacted regardless of column name.

### Side effects to be aware of

Because redaction replaces values with the literal string `<redacted>` at the data level, some queries will return misleading results:

| Query pattern                 | Effect                                                           |
| ----------------------------- | ---------------------------------------------------------------- |
| `COUNT(DISTINCT email)`       | Returns `1` — all rows appear to share the same value            |
| `GROUP BY email`              | All rows collapse into a single group                            |
| `ORDER BY email`              | Sort has no effect                                               |
| `WHERE email > 'p'`           | Filter always evaluates against `<redacted>`, not the real value |
| `COALESCE(email, 'fallback')` | Returns `<redacted>`, not the fallback                           |

These are expected trade-offs. Queries involving aggregation, grouping, or filtering on redacted columns will not reflect production data — which is intentional since those columns may contain PII.

> For a full security analysis of the anonymization layer, see [docs/anonymization_report.md](docs/anonymization_report.md).

---

## Acknowledgements

Heavily inspired by [crystaldba/postgres-mcp](https://github.com/crystaldba/postgres-mcp).

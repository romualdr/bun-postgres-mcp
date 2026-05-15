#!/usr/bin/env bun
import { run } from './src/mcp'

await run().catch(console.error)

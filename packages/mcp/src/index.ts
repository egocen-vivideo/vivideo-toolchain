#!/usr/bin/env node
import { redact } from '@vivideo/core'
import { main } from './server.js'

main().catch((err) => {
  // Redact defensively — a startup error must never surface a key.
  process.stderr.write('[vivideo-mcp] fatal: ' + redact(String(err?.message ?? err)) + '\n')
  process.exit(1)
})

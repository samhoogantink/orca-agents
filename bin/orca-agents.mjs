#!/usr/bin/env node
// Thin launcher so `npm link` exposes an `orca-agents` command.
// Node 22.18+ runs the TypeScript sources directly (type stripping), so there is no build step.
import '../src/cli.ts'

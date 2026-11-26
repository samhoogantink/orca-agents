#!/usr/bin/env node
// Optional Claude Code status line that records your plan limits for orca-agents. The default
// `claude-cli` probe reads `claude -p /usage` and only falls back to this feed when that fails.
// Claude Code sends a JSON object on stdin; for Pro and Max plans it includes `rate_limits`
// (five_hour / seven_day with used_percentage and resets_at). This script saves that object to
// ~/.orca-agents/feeds/claude-rate-limits.json and prints a one-line status.
//
// ~/.claude/settings.json:
//   { "statusLine": { "type": "command", "command": "node /path/to/orca-agents/scripts/claude-statusline.mjs" } }
//
// Note: Orca keeps a status line you own, so with this in place Orca's own Claude meter relies on
// its usage polling (on by default) rather than the status-line feed.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

let input = ''
process.stdin.on('data', (chunk) => (input += chunk))
process.stdin.on('end', () => {
	let data = {}
	try {
		data = JSON.parse(input)
	} catch {
		// Not JSON: print nothing rather than break the status line.
	}
	const limits = data.rate_limits
	if (limits) {
		const dir = join(process.env.ORCA_AGENTS_HOME || join(homedir(), '.orca-agents'), 'feeds')
		mkdirSync(dir, { recursive: true })
		const file = join(dir, 'claude-rate-limits.json')
		const tmp = `${file}.${process.pid}.tmp`
		writeFileSync(tmp, JSON.stringify({ writtenAt: Date.now(), rate_limits: limits }))
		renameSync(tmp, file)
	}
	const pct = (w) => (typeof w?.used_percentage === 'number' ? `${Math.round(w.used_percentage)}%` : '?')
	const model = data.model?.display_name ?? 'Claude'
	process.stdout.write(limits ? `${model} | 5h ${pct(limits.five_hour)} | 7d ${pct(limits.seven_day)}` : model)
})

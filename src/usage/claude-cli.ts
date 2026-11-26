import { tmpdir } from 'node:os'
import { killTree, spawnPiped } from '../proc.ts'
import { unknownUsage, type ProviderUsage, type UsageWindow } from './types.ts'

/**
 * `claude -p /usage` is answered by Claude Code itself, without a model call, and prints the same
 * plan limits as `/usage` in a session. The flags after it only matter if a future version sends
 * `/usage` to the model instead: a small model, no tools, no MCP servers and a budget cap keep
 * that call cheap, and the probe then pauses itself (see probeOne in ./index.ts).
 */
export const CLAUDE_PROBE_ARGS = [
	'-p', '/usage',
	'--output-format', 'json',
	'--model', 'haiku',
	'--max-budget-usd', '0.01',
	'--tools', '',
	'--strict-mcp-config',
	'--no-session-persistence'
]

const SOURCE = 'claude-cli'
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** Offset of `timeZone` from UTC at `epoch`, in milliseconds. */
function zoneOffsetMs(epoch: number, timeZone: string): number {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat('en-US', {
			timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
			hour: 'numeric', minute: 'numeric', second: 'numeric'
		}).formatToParts(new Date(epoch)).map((p) => [p.type, Number(p.value)])
	)
	const wall = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!)
	return wall - Math.floor(epoch / 1000) * 1000
}

/** Epoch milliseconds for a wall-clock time in `timeZone`. Month and day may overflow, as in Date.UTC. */
function zonedEpoch(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
	const wall = Date.UTC(year, month, day, hour, minute)
	const first = wall - zoneOffsetMs(wall, timeZone)
	return wall - zoneOffsetMs(first, timeZone)
}

function validZone(zone: string | undefined): string | undefined {
	if (!zone) return undefined
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: zone })
		return zone
	} catch {
		return undefined
	}
}

/**
 * Parses reset times as `/usage` prints them: "Nov 26, 7:39pm (Europe/Amsterdam)", or "7pm" for
 * later today. There is no year, so a date more than a day in the past means next year.
 */
export function parseResetTime(text: string, now = Date.now(), localZone?: string): number | null {
	const m = /^(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:\(([^)]+)\))?\s*$/i.exec(text.trim())
	if (!m) return null
	const zone = validZone(m[6]?.trim()) ?? validZone(localZone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone
	const hour = (Number(m[3]) % 12) + (m[5]!.toLowerCase() === 'pm' ? 12 : 0)
	const minute = Number(m[4] ?? 0)
	if (hour > 23 || minute > 59) return null
	const today = Object.fromEntries(
		new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric' })
			.formatToParts(new Date(now)).map((p) => [p.type, Number(p.value)])
	)
	if (m[1]) {
		const month = MONTHS.indexOf(m[1].toLowerCase())
		const day = Number(m[2])
		if (month < 0 || day < 1 || day > 31) return null
		const at = zonedEpoch(today.year!, month, day, hour, minute, zone)
		return at < now - 24 * 3600 * 1000 ? zonedEpoch(today.year! + 1, month, day, hour, minute, zone) : at
	}
	const at = zonedEpoch(today.year!, today.month! - 1, today.day!, hour, minute, zone)
	return at <= now ? zonedEpoch(today.year!, today.month! - 1, today.day! + 1, hour, minute, zone) : at
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/**
 * Maps the text of `/usage`:
 *   Current session: 5% used · resets Nov 26, 7:39pm (Europe/Amsterdam)
 *   Current week (all models): 2% used · resets Nov 30, 8:59am (Europe/Amsterdam)
 *   Current week (Sonnet only): 10% used · resets ...
 * The session and all-models week meter the whole plan. A model-scoped week becomes a named pool
 * ("sonnet-only") that only models mapped to that billing class are checked against.
 */
export function mapClaudeUsageText(text: string, now = Date.now(), localZone?: string): ProviderUsage {
	const windows: UsageWindow[] = []
	const line = /^\s*Current\s+(session|week)\s*(?:\(([^)]*)\))?\s*:\s*(\d+(?:\.\d+)?)\s*%\s*used(?:\s*[·•|,-]\s*resets\s+(.+?))?\s*$/gim
	for (const m of text.matchAll(line)) {
		const scope = m[2]?.trim()
		const whole = !scope || /^all models$/i.test(scope)
		const kind = m[1]!.toLowerCase() === 'session' ? 'session' : 'weekly'
		windows.push({
			name: whole ? kind : `${kind} (${scope})`,
			pool: whole ? 'included' : slug(scope),
			usedPercent: Number(m[3]),
			resetsAt: m[4] ? parseResetTime(m[4], now, localZone) : null
		})
	}
	if (!windows.length) {
		const first = text.trim().split(/\r?\n/).find((l) => l.trim()) ?? '(empty)'
		return { ...unknownUsage('claude', SOURCE, `no plan limits in /usage output: ${first.slice(0, 200)}`), fetchedAt: now }
	}
	return { provider: 'claude', status: 'ok', source: SOURCE, windows, detail: 'claude -p /usage', fetchedAt: now }
}

export type ClaudePrintResult = {
	result?: unknown
	is_error?: unknown
	num_turns?: unknown
	total_cost_usd?: unknown
}

/** `billedUsd` is set when Claude Code sent /usage to the model instead of answering it locally. */
export type ClaudeCliProbe = { usage: ProviderUsage; billedUsd?: number }

export function mapClaudePrintResult(out: ClaudePrintResult, now = Date.now(), localZone?: string): ClaudeCliProbe {
	const cost = typeof out.total_cost_usd === 'number' ? out.total_cost_usd : 0
	const turns = typeof out.num_turns === 'number' ? out.num_turns : 0
	if (cost > 0 || turns > 0) {
		return {
			usage: { ...unknownUsage('claude', SOURCE, `Claude Code sent /usage to the model (${turns} turns, $${cost.toFixed(4)})`), fetchedAt: now },
			billedUsd: cost
		}
	}
	if (typeof out.result !== 'string') {
		return { usage: { ...unknownUsage('claude', SOURCE, 'claude -p returned no result text'), fetchedAt: now } }
	}
	if (out.is_error === true) {
		return { usage: { ...unknownUsage('claude', SOURCE, `claude -p failed: ${out.result.trim().slice(0, 200)}`), fetchedAt: now } }
	}
	return { usage: mapClaudeUsageText(out.result, now, localZone) }
}

export function probeClaudeCli(
	opts: { command?: string; prefixArgs?: string[]; timeoutMs?: number; cwd?: string } = {}
): Promise<ClaudeCliProbe> {
	const timeoutMs = opts.timeoutMs ?? 45_000
	return new Promise((resolve) => {
		let settled = false
		let stdout = ''
		let stderr = ''
		// A neutral folder, so no project's CLAUDE.md, hooks or settings come along.
		const child = spawnPiped(opts.command ?? 'claude', [...(opts.prefixArgs ?? []), ...CLAUDE_PROBE_ARGS], { cwd: opts.cwd ?? tmpdir() })
		const finish = (probe: ClaudeCliProbe) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			killTree(child)
			resolve(probe)
		}
		const fail = (detail: string) => finish({ usage: unknownUsage('claude', SOURCE, detail) })
		const timer = setTimeout(() => fail(`timed out after ${timeoutMs}ms`), timeoutMs)
		child.stdin?.end()
		child.on('error', (error) => fail(error.message))
		child.stdout?.on('data', (chunk: Buffer) => {
			stdout = (stdout + chunk.toString('utf8')).slice(-256 * 1024)
		})
		child.stderr?.on('data', (chunk: Buffer) => {
			stderr = (stderr + chunk.toString('utf8')).slice(-4000)
		})
		child.on('close', (code) => {
			const start = stdout.indexOf('{')
			const end = stdout.lastIndexOf('}')
			let parsed: ClaudePrintResult | undefined
			if (start >= 0 && end > start) {
				try {
					parsed = JSON.parse(stdout.slice(start, end + 1))
				} catch {
					// Fall through to the exit report below.
				}
			}
			if (parsed && typeof parsed === 'object') finish(mapClaudePrintResult(parsed))
			else fail(`claude exited (${code}) without JSON: ${(stderr || stdout).trim().slice(-300)}`)
		})
	})
}

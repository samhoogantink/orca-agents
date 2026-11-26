import { killTree, spawnPiped } from '../proc.ts'
import { unknownUsage, type ProviderUsage, type UsageWindow } from './types.ts'

/**
 * Reads Codex plan limits through `codex app-server` (JSON-RPC over stdio), the same way Orca's
 * status bar does: initialize -> initialized -> account/rateLimits/read. Read-only sandbox, no approvals.
 */
export const CODEX_PROBE_ARGS = [
	'-c', 'approval_policy=never',
	'-c', 'features.plugins=false',
	'-s', 'read-only',
	'-a', 'never',
	'app-server'
]

type RawWindow = { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown }
export type CodexRateLimitsResult = {
	rateLimits?: {
		primary?: RawWindow | null
		secondary?: RawWindow | null
		individualLimit?: { remainingPercent?: unknown; resetsAt?: unknown } | null
		planType?: unknown
	} | null
}

function windowName(minutes: unknown, fallback: string): string {
	if (typeof minutes !== 'number') return fallback
	if (Math.abs(minutes - 300) <= 1) return 'session'
	if (Math.abs(minutes - 10_080) <= 1) return 'weekly'
	return `${minutes}m`
}

function toWindow(raw: RawWindow | null | undefined, fallbackName: string): UsageWindow | null {
	if (!raw || typeof raw.usedPercent !== 'number' || !Number.isFinite(raw.usedPercent)) return null
	const resetsAt =
		typeof raw.resetsAt === 'number' && raw.resetsAt > 0 ? raw.resetsAt * 1000 : null // Codex uses epoch seconds
	return {
		name: windowName(raw.windowDurationMins, fallbackName),
		pool: 'included',
		usedPercent: Math.min(100, Math.max(0, raw.usedPercent)),
		resetsAt
	}
}

export function mapCodexRateLimits(result: CodexRateLimitsResult, now = Date.now()): ProviderUsage {
	const rl = result?.rateLimits
	const windows = [toWindow(rl?.primary, 'session'), toWindow(rl?.secondary, 'weekly')].filter(
		(w): w is UsageWindow => w !== null
	)
	const individual = rl?.individualLimit
	if (!windows.length && typeof individual?.remainingPercent === 'number') {
		windows.push({
			name: 'monthly',
			pool: 'included',
			usedPercent: Math.min(100, Math.max(0, 100 - individual.remainingPercent)),
			resetsAt: typeof individual.resetsAt === 'number' ? individual.resetsAt * 1000 : null
		})
	}
	if (!windows.length) {
		return { ...unknownUsage('codex', 'codex-app-server', 'no rate-limit windows reported'), fetchedAt: now }
	}
	return {
		provider: 'codex',
		status: 'ok',
		source: 'codex-app-server',
		windows,
		detail: typeof rl?.planType === 'string' ? `plan: ${rl.planType}` : undefined,
		fetchedAt: now
	}
}

export function probeCodex(
	opts: { command?: string; prefixArgs?: string[]; timeoutMs?: number } = {}
): Promise<ProviderUsage> {
	const command = opts.command ?? 'codex'
	const timeoutMs = opts.timeoutMs ?? 20_000
	return new Promise((resolve) => {
		let settled = false
		let buffer = ''
		let stderr = ''
		const child = spawnPiped(command, [...(opts.prefixArgs ?? []), ...CODEX_PROBE_ARGS])
		const finish = (usage: ProviderUsage) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			killTree(child)
			resolve(usage)
		}
		const timer = setTimeout(
			() => finish(unknownUsage('codex', 'codex-app-server', `timed out after ${timeoutMs}ms`)),
			timeoutMs
		)
		const send = (msg: object) => child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)

		child.on('error', (err) => finish(unknownUsage('codex', 'codex-app-server', err.message)))
		child.on('close', (code) =>
			finish(unknownUsage('codex', 'codex-app-server', `app-server exited (${code}): ${stderr.trim().slice(-300)}`))
		)
		child.stderr?.on('data', (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-4000)
		})
		child.stdout?.on('data', (chunk: Buffer) => {
			buffer += chunk.toString()
			let idx: number
			while ((idx = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, idx).trim()
				buffer = buffer.slice(idx + 1)
				if (!line) continue
				let msg: { id?: number; result?: unknown; error?: { message: string } }
				try {
					msg = JSON.parse(line)
				} catch {
					continue
				}
				if (msg.id === 1) {
					send({ method: 'initialized', params: {} })
					send({ id: 2, method: 'account/rateLimits/read', params: {} })
				} else if (msg.id === 2) {
					finish(
						msg.error
							? unknownUsage('codex', 'codex-app-server', msg.error.message)
							: mapCodexRateLimits(msg.result as CodexRateLimitsResult)
					)
				}
			}
		})
		send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'orca-agents', version: '0.1.0' } } })
	})
}

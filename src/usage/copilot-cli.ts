import { killTree, spawnPiped } from '../proc.ts'
import { unknownUsage, type ProviderUsage } from './types.ts'

export const COPILOT_PROBE_ARGS = ['--headless', '--stdio', '--no-auto-update', '--log-level', 'none']

type QuotaSnapshot = {
	isUnlimitedEntitlement?: unknown
	entitlementRequests?: unknown
	usedRequests?: unknown
	remainingPercentage?: unknown
	resetDate?: unknown
}

export type CopilotQuotaResult = {
	quotaSnapshots?: Record<string, QuotaSnapshot | null> | null
}

/** Account quota comes from the signed-in Copilot runtime, without creating a session or prompt. */
export function mapCopilotQuota(result: CopilotQuotaResult | null, now = Date.now()): ProviderUsage {
	const premium = result?.quotaSnapshots?.premium_interactions
	const getUnavailableQuota = () => ({
		...unknownUsage('copilot', 'copilot-cli', 'no usable premium_interactions quota reported'),
		fetchedAt: now
	})
	if (!premium) return getUnavailableQuota()
	if (premium.isUnlimitedEntitlement === true || premium.entitlementRequests === -1) {
		return {
			provider: 'copilot', status: 'ok', source: 'copilot-cli', windows: [],
			detail: 'unlimited premium interactions', fetchedAt: now
		}
	}
	const remaining = premium.remainingPercentage
	const entitlement = premium.entitlementRequests
	const used = premium.usedRequests
	let usedPercent: number
	if (typeof remaining === 'number' && Number.isFinite(remaining) && remaining >= 0 && remaining <= 100) {
		usedPercent = 100 - remaining
	} else if (
		typeof entitlement === 'number' && Number.isFinite(entitlement) && entitlement > 0 &&
		typeof used === 'number' && Number.isFinite(used) && used >= 0
	) {
		usedPercent = Math.min(100, (used / entitlement) * 100)
	} else {
		return getUnavailableQuota()
	}
	// A zero entitlement is not evidence of unused included quota.
	if (entitlement === 0) return getUnavailableQuota()
	const reset = typeof premium.resetDate === 'string' ? Date.parse(premium.resetDate) : NaN
	// Quota and overage request counts do not tell us dollar spend. Leave extra unmeasured.
	return {
		provider: 'copilot', status: 'ok', source: 'copilot-cli',
		windows: [{ name: 'monthly', pool: 'included', usedPercent, resetsAt: Number.isFinite(reset) ? reset : null }],
		detail: 'premium interactions (Copilot account quota)', fetchedAt: now
	}
}

/** Copilot uses Content-Length framed JSON-RPC, unlike Codex's newline-delimited transport. */
export function probeCopilotQuota(
	opts: { command?: string; prefixArgs?: string[]; timeoutMs?: number } = {}
): Promise<ProviderUsage> {
	const timeoutMs = opts.timeoutMs ?? 20_000
	return new Promise((resolve) => {
		let settled = false
		let buffer: Buffer = Buffer.alloc(0)
		let stderr = ''
		const child = spawnPiped(opts.command ?? 'copilot', [...(opts.prefixArgs ?? []), ...COPILOT_PROBE_ARGS])
		const finish = (usage: ProviderUsage) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			child.stdin?.end()
			killTree(child)
			resolve(usage)
		}
		const fail = (detail: string) => finish(unknownUsage('copilot', 'copilot-cli', detail))
		const timer = setTimeout(() => fail(`timed out after ${timeoutMs}ms`), timeoutMs)
		const sendRequest = (id: number, method: string) => {
			const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: {} })
			child.stdin?.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
		}
		child.on('error', (error) => fail(error.message))
		child.stdin?.on('error', (error) => fail(`Copilot input failed: ${error.message}`))
		child.on('close', (code) => fail(`Copilot exited (${code}): ${stderr.trim().slice(-300)}`))
		child.stderr?.on('data', (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-4000)
		})
		child.stdout?.on('data', (chunk: Buffer) => {
			if (settled) return
			buffer = Buffer.concat([buffer, chunk])
			while (!settled) {
				const headerEnd = buffer.indexOf('\r\n\r\n')
				if (headerEnd === -1) {
					if (buffer.length > 8192) fail('invalid Copilot RPC header')
					return
				}
				const lengthHeader = /(?:^|\r\n)Content-Length:\s*(\d+)\s*(?:\r\n|$)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'))
				const length = Number(lengthHeader?.[1])
				if (!Number.isSafeInteger(length) || length <= 0 || length > 1024 * 1024) {
					fail('invalid Copilot RPC Content-Length')
					return
				}
				const messageEnd = headerEnd + 4 + length
				if (buffer.length < messageEnd) return
				let message: { id?: unknown; error?: { code?: number; message?: string }; result?: CopilotQuotaResult }
				try {
					message = JSON.parse(buffer.subarray(headerEnd + 4, messageEnd).toString('utf8'))
					if (!message || typeof message !== 'object') throw new Error('expected an RPC object')
				} catch {
					fail('invalid Copilot RPC JSON')
					return
				}
				buffer = buffer.subarray(messageEnd)
				if (message.id === 1) {
					if (message.error?.code === -32601) sendRequest(2, 'ping')
					else if (message.error) fail(`Copilot connect failed: ${message.error.message ?? 'unknown error'}`)
					else sendRequest(3, 'account.getQuota')
				} else if (message.id === 2) {
					if (message.error) fail(`Copilot ping failed: ${message.error.message ?? 'unknown error'}`)
					else sendRequest(3, 'account.getQuota')
				} else if (message.id === 3) {
					if (message.error) {
						fail(`account.getQuota failed: ${message.error.message ?? 'unknown error'}; check Copilot sign-in and CLI version`)
					} else {
						finish(mapCopilotQuota(message.result ?? null))
					}
				}
			}
		})
		sendRequest(1, 'connect')
	})
}

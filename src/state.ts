import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ProviderUsage } from './usage/types.ts'

export type DispatchRecord = {
	dispatchId: string
	taskId: string
	runId?: string
	role: string
	provider: string
	model?: string | null
	/** Model vendor (openai, anthropic, ...) at the time it started, when it could be told. */
	vendor?: string | null
	/** Reviews: the dispatch whose code this one reviews, and the vendors it may not run on. */
	reviewOf?: string
	avoidVendors?: string[]
	/** free, included or extra (paid on top of the plan) at the time it started */
	billing?: string
	worktree: string
	workspace?: string
	terminal?: string
	startedAt: string
	retryOf?: string
	outcome?: 'rerouted' | 'succeeded' | 'failed'
}

export type Cooldown = { until: number; reason: string }

export type State = {
	dispatches: Record<string, DispatchRecord>
	cooldowns: Record<string, Cooldown>
	/** provider -> YYYY-MM-DD -> number of dispatches this tool started */
	ledger: Record<string, Record<string, number>>
	usageCache?: { fetchedAt: number; usage: Record<string, ProviderUsage> }
	/** probe -> pause, for probes that stopped themselves (claude-cli after a billed call). */
	probePauses?: Record<string, Cooldown>
}

export const emptyState = (): State => ({ dispatches: {}, cooldowns: {}, ledger: {} })

export function loadState(path: string): State {
	if (!existsSync(path)) return emptyState()
	try {
		return { ...emptyState(), ...JSON.parse(readFileSync(path, 'utf8')) }
	} catch {
		// A corrupt state file should not block routing; start over.
		return emptyState()
	}
}

export function saveState(path: string, state: State): void {
	mkdirSync(dirname(path), { recursive: true })
	const tmp = `${path}.${process.pid}.tmp`
	writeFileSync(tmp, JSON.stringify(state, null, 2))
	renameSync(tmp, path)
}

export const dayKey = (now: number): string => new Date(now).toISOString().slice(0, 10)

export function dispatchesToday(state: State, provider: string, now: number): number {
	return state.ledger[provider]?.[dayKey(now)] ?? 0
}

export function recordDispatch(state: State, record: DispatchRecord, now: number): void {
	state.dispatches[record.dispatchId] = record
	const day = dayKey(now)
	const perProvider = (state.ledger[record.provider] ??= {})
	perProvider[day] = (perProvider[day] ?? 0) + 1
	// Keep the ledger small: drop days older than ~35 days.
	const cutoff = dayKey(now - 35 * 24 * 3600 * 1000)
	for (const key of Object.keys(perProvider)) if (key < cutoff) delete perProvider[key]
}

export function activeCooldown(state: State, provider: string, now: number): Cooldown | null {
	const c = state.cooldowns[provider]
	return c && c.until > now ? c : null
}

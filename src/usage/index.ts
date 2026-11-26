import { executablesFor, type Config, type ProviderConfig } from '../config.ts'
import { dispatchesToday, type State } from '../state.ts'
import { probeClaude } from './claude.ts'
import { probeClaudeCli, type ClaudeCliProbe } from './claude-cli.ts'
import { probeCodex } from './codex.ts'
import { probeCopilotUsage } from './copilot.ts'
import { unknownUsage, type ProviderUsage } from './types.ts'

export const USAGE_CACHE_TTL_MS = 5 * 60 * 1000
/** How long the claude-cli probe stays off after Claude Code billed a /usage call. */
export const CLAUDE_CLI_PAUSE_MS = 24 * 3600 * 1000

export type ProbeDeps = {
	claudeFeedPath: string
	now?: number
	/** Test seam for the claude-cli probe. */
	claudeCli?: (command: string) => Promise<ClaudeCliProbe>
}

/** `claude -p /usage` first; the status-line feed when the CLI cannot tell or is paused. */
async function probeClaudeWithFallback(name: string, provider: ProviderConfig, state: State, deps: ProbeDeps, now: number): Promise<ProviderUsage> {
	const pause = state.probePauses?.['claude-cli']
	let cliDetail: string
	if (pause && pause.until > now) {
		cliDetail = `claude-cli paused until ${new Date(pause.until).toISOString()}: ${pause.reason}`
	} else {
		const run = deps.claudeCli ?? ((command: string) => probeClaudeCli({ command }))
		const cli = await run(executablesFor(provider)[0]!)
		if (cli.usage.status === 'ok') return { ...cli.usage, provider: name }
		cliDetail = cli.usage.detail ?? 'claude-cli unknown'
		if (cli.billedUsd !== undefined) {
			const reason = `${cliDetail}; using the status-line feed meanwhile`
			state.probePauses = { ...state.probePauses, 'claude-cli': { until: now + CLAUDE_CLI_PAUSE_MS, reason } }
			cliDetail = `claude-cli paused for 24h: ${reason}`
		}
	}
	const feed = probeClaude(deps.claudeFeedPath)
	if (feed.status === 'ok') return { ...feed, provider: name, detail: `status-line feed (${cliDetail})` }
	return { ...unknownUsage(name, 'claude-cli', `${cliDetail}; status-line fallback: ${feed.detail}`), fetchedAt: now }
}

async function probeOne(name: string, provider: ProviderConfig, state: State, deps: ProbeDeps): Promise<ProviderUsage> {
	const now = deps.now ?? Date.now()
	if (!provider.enabled) {
		return { provider: name, status: 'disabled', source: provider.usage.probe, windows: [], fetchedAt: now }
	}
	switch (provider.usage.probe) {
		case 'codex-app-server':
			return { ...(await probeCodex()), provider: name }
		case 'github-billing':
		case 'copilot-cli':
			return { ...(await probeCopilotUsage(provider.usage, { command: executablesFor(provider)[0] })), provider: name }
		case 'claude-cli':
			return probeClaudeWithFallback(name, provider, state, deps, now)
		case 'claude-statusline':
			return { ...probeClaude(deps.claudeFeedPath), provider: name }
		case 'ledger': {
			const count = dispatchesToday(state, name, now)
			const max = provider.limits.maxDispatchesPerDay
			return {
				provider: name,
				status: 'ok',
				source: 'ledger',
				windows: [],
				detail: `${count} dispatches today${max ? ` (local limit ${max})` : ''}`,
				fetchedAt: now
			}
		}
	}
}

/** Probes every provider in parallel, reusing a cached snapshot for up to five minutes. */
export async function collectUsage(
	config: Config,
	state: State,
	deps: ProbeDeps & { refresh?: boolean; only?: string[] }
): Promise<Record<string, ProviderUsage>> {
	const now = deps.now ?? Date.now()
	const names = Object.keys(config.providers).filter((n) => !deps.only || deps.only.includes(n))
	const cache = state.usageCache

	const results = await Promise.all(
		names.map(async (name) => {
			const provider = config.providers[name]!
			const cached = cache?.usage[name]
			const fresh = !deps.refresh && cached && now - cached.fetchedAt < USAGE_CACHE_TTL_MS
			// Ledger numbers are local and cheap, so they are always recomputed.
			if (fresh && provider.enabled && provider.usage.probe !== 'ledger' && cached.status !== 'disabled' &&
				(provider.usage.probe !== 'copilot-cli' || cached.source === 'copilot-cli')) {
				return [name, cached] as const
			}
			return [name, await probeOne(name, provider, state, deps)] as const
		})
	)
	const usage = Object.fromEntries(results)
	state.usageCache = { fetchedAt: now, usage: { ...cache?.usage, ...usage } }
	return usage
}

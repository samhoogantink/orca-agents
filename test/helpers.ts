import type { Config } from '../src/config.ts'
import type { OrcaRunner } from '../src/orca.ts'
import { emptyState, type State } from '../src/state.ts'
import type { ExtraUsage, ProviderUsage, UsageWindow } from '../src/usage/types.ts'

export const NOW = Date.UTC(2026, 10, 17, 22, 0, 0)

export function testConfig(): Config {
	return {
		unknownUsage: 'allow',
		configDir: '/nonexistent',
		providers: {
			codex: {
				enabled: true,
				orcaAgent: 'codex',
				supportsModelFlag: true,
				usage: { probe: 'codex-app-server' },
				vendors: { default: 'openai' },
				limits: { included: { maxUsedPercent: 85 }, extra: { enabled: false } },
				cooldownMinutes: 60
			},
			pooled: {
				enabled: true,
				orcaAgent: 'pooled',
				cli: ['pooled-agent', 'agent'],
				supportsModelFlag: true,
				usage: { probe: 'ledger' },
				vendors: { default: 'google' },
				limits: {
					included: { maxUsedPercent: 90, pools: { 'other-models': 80 } },
					extra: { enabled: false, maxUsedPercent: 50 },
					maxDispatchesPerDay: 2
				},
				models: { default: 'included', auto: 'fast-models', 'fast-*': 'fast-models', 'gpt-*': 'other-models' },
				cooldownMinutes: 60
			},
			copilot: {
				enabled: true,
				orcaAgent: 'copilot',
				supportsModelFlag: false,
				usage: { probe: 'github-billing', monthlyAllowance: 300 },
				vendors: { default: 'anthropic' },
				limits: { included: { maxUsedPercent: 90 }, extra: { enabled: false, maxSpendUsd: 10 } },
				models: { default: 'included', 'mini-model': 'free', 'premium-*': 'extra' },
				cooldownMinutes: 120
			},
			claude: {
				enabled: false,
				orcaAgent: 'claude',
				supportsModelFlag: true,
				usage: { probe: 'claude-statusline' },
				vendors: { default: 'anthropic' },
				limits: { included: { maxUsedPercent: 85 } },
				cooldownMinutes: 60
			}
		},
		roles: {
			'junior-backend': {
				prompt: 'roles/junior-backend.md',
				worktree: 'new-child',
				candidates: [
					{ provider: 'codex', model: 'gpt-x', effort: 'high' },
					{ provider: 'copilot', model: 'claude-y' },
					{ provider: 'claude' },
					{ provider: 'pooled' }
				]
			},
			reviewer: {
				prompt: 'roles/reviewer.md',
				worktree: 'current',
				candidates: [{ provider: 'copilot' }, { provider: 'codex' }, { provider: 'pooled' }]
			}
		}
	}
}

export const win = (name: string, usedPercent: number, pool = 'included', resetsAt: number | null = NOW + 3_600_000): UsageWindow => ({
	name,
	pool,
	usedPercent,
	resetsAt
})

export const okUsage = (provider: string, ...percents: number[]): ProviderUsage => ({
	provider,
	status: 'ok',
	source: 'test',
	windows: percents.map((p, i) => win(i === 0 ? 'session' : 'weekly', p, 'included', NOW + (i + 1) * 3_600_000)),
	fetchedAt: NOW
})

export const usageWith = (provider: string, windows: UsageWindow[], extra?: ExtraUsage): ProviderUsage => ({
	provider,
	status: 'ok',
	source: 'test',
	windows,
	extra,
	fetchedAt: NOW
})

export const freshState = (): State => emptyState()

/** Records every Orca call and answers from a script of handlers keyed by "group verb". */
export function fakeRunner(handlers: Record<string, (args: string[]) => { ok: boolean; result?: unknown; error?: string }>) {
	const calls: string[][] = []
	let n = 0
	const runner: OrcaRunner = (args) => {
		calls.push(args)
		const key = args.slice(0, 2).join(' ')
		const handler = handlers[key]
		const out = handler ? handler(args) : { ok: true, result: {} }
		n++
		if (!out.ok) return { code: 1, stdout: '', stderr: `error: test_failure: ${out.error}` }
		return { code: 0, stdout: JSON.stringify({ ok: true, result: out.result ?? { n } }), stderr: '' }
	}
	return { runner, calls }
}

export const flag = (args: string[], name: string) => {
	const i = args.indexOf(`--${name}`)
	return i >= 0 ? args[i + 1] : undefined
}

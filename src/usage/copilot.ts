import type { UsageConfig } from '../config.ts'
import { runSync, type RunResult } from '../proc.ts'
import { probeCopilotQuota } from './copilot-cli.ts'
import { unknownUsage, type ProviderUsage } from './types.ts'

/**
 * Copilot usage from GitHub's billing REST API, called through the `gh` CLI so no token handling
 * lives here:
 *   GET /users/{username}/settings/billing/premium_request/usage   (or .../ai_credit/usage)
 * Each usage item splits into what the plan covered (discount) and what was billed (net), which
 * maps onto included usage and extra (paid) usage.
 * Needs a token with the "Plan" user permission (read), and only covers a Copilot plan you pay for
 * yourself. Seats billed to an organization report through the org endpoints instead.
 */
export const GITHUB_API_VERSION = '2026-03-10'

type UsageItem = {
	product?: string
	model?: string
	grossQuantity?: number
	discountQuantity?: number
	netQuantity?: number
	netAmount?: number
}
export type BillingReport = { usageItems?: UsageItem[] }

export type GhRunner = (args: string[]) => RunResult
const defaultGh: GhRunner = (args) => runSync('gh', args, { timeoutMs: 30_000 })

export function startOfNextMonthUtc(now: number): number {
	const d = new Date(now)
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
}

export function mapBillingReport(report: BillingReport, allowance: number, now = Date.now()): ProviderUsage {
	const items = (report.usageItems ?? []).filter((item) => !item.product || /copilot/i.test(item.product))
	const sum = (pick: (i: UsageItem) => number | undefined) => items.reduce((total, i) => total + (pick(i) ?? 0), 0)
	const gross = sum((i) => i.grossQuantity)
	const billedQuantity = sum((i) => i.netQuantity)
	const spentUsd = Math.round(sum((i) => i.netAmount) * 100) / 100
	const resetsAt = startOfNextMonthUtc(now)
	return {
		provider: 'copilot',
		status: 'ok',
		source: 'github-billing',
		windows: [{ name: 'monthly', pool: 'included', usedPercent: Math.min(100, (gross / allowance) * 100), resetsAt }],
		extra: {
			spentUsd,
			resetsAt,
			detail: `${Math.round(billedQuantity)} billed beyond the plan ($${spentUsd.toFixed(2)})`
		},
		detail: `${Math.round(gross)} of ${allowance} included used this month`,
		fetchedAt: now
	}
}

export function probeCopilot(usage: UsageConfig, gh: GhRunner = defaultGh): ProviderUsage {
	const allowance = usage.monthlyAllowance
	if (!allowance || allowance <= 0) {
		return unknownUsage('copilot', 'github-billing', 'set usage.monthlyAllowance in providers.json')
	}
	const login = gh(['api', 'user', '--jq', '.login'])
	if (login.code !== 0) {
		return unknownUsage('copilot', 'github-billing', `gh api user failed: ${(login.error ?? login.stderr).trim()}`)
	}
	const unit = usage.unit ?? 'premium_request'
	const path = `/users/${login.stdout.trim()}/settings/billing/${unit}/usage`
	const res = gh(['api', '-H', `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`, path])
	if (res.code !== 0) {
		return unknownUsage('copilot', 'github-billing', `${path} failed: ${(res.error ?? res.stderr).trim().slice(0, 300)}`)
	}
	try {
		return mapBillingReport(JSON.parse(res.stdout) as BillingReport, allowance)
	} catch (err) {
		return unknownUsage('copilot', 'github-billing', `unreadable billing response: ${String(err)}`)
	}
}

/** Keep existing billing configs working, including company seats without billing API access. */
export async function probeCopilotUsage(
	usage: UsageConfig,
	opts: Parameters<typeof probeCopilotQuota>[0] & { gh?: GhRunner } = {}
): Promise<ProviderUsage> {
	if (usage.probe === 'copilot-cli') return probeCopilotQuota(opts)
	const billing = probeCopilot(usage, opts.gh)
	if (billing.status === 'ok') return billing
	const quota = await probeCopilotQuota(opts)
	return quota.status === 'unknown'
		? { ...quota, detail: `${quota.detail}; billing unavailable: ${billing.detail}` }
		: quota
}

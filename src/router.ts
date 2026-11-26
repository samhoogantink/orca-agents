import { billingClass, modelVendor, type Candidate, type Config, type ProviderConfig } from './config.ts'
import { activeCooldown, dispatchesToday, type State } from './state.ts'
import type { ProviderUsage, UsageWindow } from './usage/types.ts'

/** What starting this candidate costs: nothing, included plan usage, or paid usage on top. */
export type Billing = 'free' | 'included' | 'extra'

export type Considered = {
	provider: string
	model: string | null
	verdict: 'chosen' | 'skipped'
	billing?: Billing
	reason: string
}

export type Choice = {
	provider: string
	agent: string
	model: string | null
	effort: string | null
	/** Who made the model (openai, anthropic, ...), or null when it cannot be told. */
	vendor: string | null
	billing: Billing
	warnings: string[]
}

export type RouteDecision = {
	role: string
	chosen: Choice | null
	considered: Considered[]
}

export type RouteContext = {
	usage: Record<string, ProviderUsage>
	state: State
	now: number
	avoid?: string[]
	/**
	 * Reviews: model vendors that wrote the code under review. Candidates on one of these vendors, or
	 * whose vendor cannot be told, are skipped. Never relaxed, not even by allowOverBudget.
	 */
	avoidVendors?: string[]
	/** Last resort: when every candidate is over its included limit, take the least-used one (never paid-only models). */
	allowOverBudget?: boolean
}

export type Evaluation = {
	blocked: string | null
	billing: Billing
	note: string
	warnings: string[]
}

function fmtTime(ms: number | null | undefined): string {
	return ms ? new Date(ms).toISOString().replace('.000Z', 'Z') : 'unknown'
}

const pct = (n: number) => `${n.toFixed(0)}%`

/** Included-usage threshold for one pool: a per-pool override, else the provider-wide one. */
export function includedThreshold(provider: ProviderConfig, pool: string): number | undefined {
	return provider.limits.included?.pools?.[pool] ?? provider.limits.included?.maxUsedPercent
}

/** Windows that meter a billing class: the plan as a whole plus the class's own pool. */
export function relevantWindows(usage: ProviderUsage | undefined, cls: string): UsageWindow[] {
	return usage?.windows.filter((w) => w.pool === 'included' || w.pool === cls) ?? []
}

/**
 * Whether paid usage on top of the plan may be used now. Fails closed: when the probe cannot
 * report the figure a cap is defined on, no money is spent.
 */
export function extraBlock(provider: ProviderConfig, usage: ProviderUsage | undefined): string | null {
	const caps = provider.limits.extra
	if (!caps?.enabled) return 'extra usage is off (limits.extra.enabled)'
	const extra = usage?.extra
	if (!extra) return 'extra usage cannot be measured, so nothing is spent (fails closed)'
	if (extra.available === false) return extra.detail ?? 'paid usage is switched off in the provider account'
	let checked = false
	if (caps.maxSpendUsd !== undefined && extra.spentUsd !== undefined) {
		checked = true
		if (extra.spentUsd >= caps.maxSpendUsd) {
			return `extra spend $${extra.spentUsd.toFixed(2)} reached the $${caps.maxSpendUsd} cap, resets ${fmtTime(extra.resetsAt)}`
		}
	}
	if (caps.maxUsedPercent !== undefined && extra.usedPercent !== undefined) {
		checked = true
		if (extra.usedPercent >= caps.maxUsedPercent) {
			return `extra usage at ${pct(extra.usedPercent)} of your account's spend limit (max ${caps.maxUsedPercent}%)`
		}
	}
	if (!checked) return 'the provider reports no figure for the configured extra cap, so nothing is spent (fails closed)'
	return null
}

/** Decides whether one candidate may start now, and how it would be billed. */
export function evaluate(
	name: string,
	provider: ProviderConfig | undefined,
	candidate: Pick<Candidate, 'model' | 'allowExtra'> | undefined,
	config: Config,
	ctx: RouteContext
): Evaluation {
	const no = (blocked: string): Evaluation => ({ blocked, billing: 'included', note: '', warnings: [] })
	if (!provider) return no('not configured')
	if (!provider.enabled) return no('disabled in providers.json')
	const cooldown = activeCooldown(ctx.state, name, ctx.now)
	if (cooldown) return no(`cooling down until ${fmtTime(cooldown.until)} (${cooldown.reason})`)
	if (ctx.avoid?.includes(name)) return no('avoided for this start')
	const maxPerDay = provider.limits.maxDispatchesPerDay
	if (maxPerDay !== undefined) {
		const today = dispatchesToday(ctx.state, name, ctx.now)
		if (today >= maxPerDay) return no(`local limit: ${today}/${maxPerDay} dispatches today`)
	}

	const usage = ctx.usage[name]
	const cls = billingClass(provider, candidate?.model)
	const extraAllowed = provider.limits.extra?.enabled === true && candidate?.allowExtra !== false
	const extraOff = candidate?.allowExtra === false ? 'this role may not use paid usage (allowExtra: false)' : 'extra usage is off (limits.extra.enabled)'
	const spendExtra = (why: string): Evaluation => {
		if (!extraAllowed) return no(`${why}; ${extraOff}`)
		const blocked = extraBlock(provider, usage)
		if (blocked) return no(`${why}; ${blocked}`)
		return {
			blocked: null,
			billing: 'extra',
			note: `${why}; paid: ${usage?.extra?.detail ?? 'within caps'}`,
			warnings: [`${why}: this run is billed as extra usage (${usage?.extra?.detail ?? 'within caps'})`]
		}
	}

	if (cls === 'free') return { blocked: null, billing: 'free', note: 'free on this plan', warnings: [] }
	if (cls === 'extra') return spendExtra('model is not included in the plan')

	if (!usage || usage.status === 'unknown') {
		if (config.unknownUsage === 'skip') return no(`usage unknown (${usage?.detail ?? 'not probed'}) and unknownUsage=skip`)
		return {
			blocked: null,
			billing: 'included',
			note: `usage unknown, allowed (unknownUsage=allow): ${usage?.detail ?? 'not probed'}`,
			warnings: []
		}
	}
	const windows = relevantWindows(usage, cls)
	const over = windows.find((w) => {
		const max = includedThreshold(provider, w.pool)
		return max !== undefined && w.usedPercent >= max
	})
	if (!over) {
		const note = windows.length
			? windows.map((w) => `${w.name} ${pct(w.usedPercent)}`).join(', ')
			: usage.detail ?? 'ok'
		return { blocked: null, billing: 'included', note, warnings: [] }
	}
	const why = `${over.name} at ${pct(over.usedPercent)} of included usage (max ${includedThreshold(provider, over.pool)}%, resets ${fmtTime(over.resetsAt)})`
	return spendExtra(why)
}

/** Back-compatible helper: the block reason for a provider's default model, or null. */
export function blockReason(name: string, provider: ProviderConfig | undefined, config: Config, ctx: RouteContext, model?: string | null): string | null {
	return evaluate(name, provider, { model }, config, ctx).blocked
}

function tightest(windows: UsageWindow[]): number {
	return windows.length ? Math.max(...windows.map((w) => w.usedPercent)) : 0
}

/** The model a candidate actually launches with: agents without a model flag run their own default. */
const launchModel = (c: Candidate, provider: ProviderConfig): string | null =>
	provider.supportsModelFlag ? c.model ?? null : null

/** Why a candidate may not review code written by `ctx.avoidVendors`, or null when it may. */
function vendorBlock(c: Candidate, provider: ProviderConfig | undefined, ctx: RouteContext): string | null {
	if (!ctx.avoidVendors?.length || !provider) return null
	const vendor = modelVendor(provider, launchModel(c, provider))
	if (!vendor) return `model vendor unknown, so it may be the code's author (set "vendors" for ${c.provider} in providers.json)`
	if (ctx.avoidVendors.includes(vendor)) return `same model vendor (${vendor}) as the code under review`
	return null
}

function toChoice(c: Candidate, provider: ProviderConfig, ev: Evaluation): Choice {
	const warnings = [...ev.warnings]
	const model = launchModel(c, provider)
	const effort = model ? c.effort ?? null : null
	if (c.model && !model) {
		warnings.push(
			`${provider.orcaAgent} ignores per-launch models in Orca; "${c.model}" must be set in that agent's own config`
		)
	}
	const vendor = modelVendor(provider, model)
	return { provider: c.provider, agent: provider.orcaAgent, model, effort, vendor, billing: ev.billing, warnings }
}

export function route(roleName: string, config: Config, ctx: RouteContext): RouteDecision {
	const role = config.roles[roleName]
	if (!role) throw new Error(`unknown role "${roleName}". Known roles: ${Object.keys(config.roles).join(', ')}`)

	const considered: Considered[] = []
	let chosen: Choice | null = null
	for (const candidate of role.candidates) {
		const provider = config.providers[candidate.provider]
		const model = candidate.model ?? null
		if (chosen) {
			considered.push({ provider: candidate.provider, model, verdict: 'skipped', reason: 'lower in the chain' })
			continue
		}
		const crossVendor = vendorBlock(candidate, provider, ctx)
		if (crossVendor) {
			considered.push({ provider: candidate.provider, model, verdict: 'skipped', reason: crossVendor })
			continue
		}
		const ev = evaluate(candidate.provider, provider, candidate, config, ctx)
		if (ev.blocked === null && provider) {
			chosen = toChoice(candidate, provider, ev)
			considered.push({ provider: candidate.provider, model, verdict: 'chosen', billing: ev.billing, reason: ev.note })
		} else {
			considered.push({ provider: candidate.provider, model, verdict: 'skipped', reason: ev.blocked ?? 'not configured' })
		}
	}

	if (!chosen && ctx.allowOverBudget) {
		// Only included-usage candidates with some capacity left qualify. Paid-only models, disabled,
		// avoided and cooling-down providers stay out, so this never turns into unplanned spending.
		const pool = role.candidates
			.map((c) => {
				const p = config.providers[c.provider]
				const cls = p ? billingClass(p, c.model) : 'extra'
				return { c, p, windows: relevantWindows(ctx.usage[c.provider], cls), cls }
			})
			.filter(({ c, p, windows, cls }) =>
				p?.enabled &&
				cls !== 'extra' &&
				!ctx.avoid?.includes(c.provider) &&
				!vendorBlock(c, p, ctx) &&
				!activeCooldown(ctx.state, c.provider, ctx.now) &&
				tightest(windows) < 100
			)
			.sort((a, b) => tightest(a.windows) - tightest(b.windows))
		const pick = pool[0]
		if (pick?.p) {
			chosen = toChoice(pick.c, pick.p, { blocked: null, billing: 'included', note: '', warnings: [] })
			chosen.warnings.push('every candidate was over its included limit; --allow-over-budget picked the least-used one')
			const entry = considered.find((x) => x.provider === pick.c.provider)
			if (entry) {
				entry.verdict = 'chosen'
				entry.billing = 'included'
			}
		}
	}
	return { role: roleName, chosen, considered }
}

/**
 * When a rate-limited provider becomes usable again. Prefers what the error said ("try again in 3
 * hours"), then the reset time of the exhausted included window, then the configured fixed cooldown.
 */
export function cooldownUntil(
	provider: ProviderConfig,
	usage: ProviderUsage | undefined,
	now: number,
	retryAfter?: number | null
): number {
	if (retryAfter && retryAfter > 0) return now + retryAfter
	const fixed = now + provider.cooldownMinutes * 60_000
	const blocking = usage?.windows
		.filter((w) => w.usedPercent >= (includedThreshold(provider, w.pool) ?? 100) && w.resetsAt && w.resetsAt > now)
		.map((w) => w.resetsAt!)
	return blocking?.length ? Math.max(...blocking) : fixed
}

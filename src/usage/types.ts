export type UsageWindow = {
	/** Display name: session (5h), weekly, monthly, plan, ... */
	name: string
	/** Which included pool this window meters: "included" (the plan as a whole) or a named pool. */
	pool: string
	usedPercent: number
	/** Epoch milliseconds, when known. */
	resetsAt: number | null
}

/** Usage outside the plan: overage, on-demand spend, models the plan does not include. */
export type ExtraUsage = {
	/** false when the provider account itself has paid usage switched off. */
	available?: boolean
	spentUsd?: number
	/** Percentage of the spend limit set in the provider's own account. */
	usedPercent?: number
	resetsAt?: number | null
	detail?: string
}

export type ProviderUsage = {
	provider: string
	/** ok: live numbers. unknown: probe could not tell (routing follows `unknownUsage`). */
	status: 'ok' | 'unknown' | 'disabled'
	source: string
	/** Included-plan windows. */
	windows: UsageWindow[]
	/** Absent means the probe cannot tell, and extra usage then fails closed. */
	extra?: ExtraUsage
	detail?: string
	fetchedAt: number
}

export const unknownUsage = (provider: string, source: string, detail: string): ProviderUsage => ({
	provider,
	status: 'unknown',
	source,
	windows: [],
	detail,
	fetchedAt: Date.now()
})

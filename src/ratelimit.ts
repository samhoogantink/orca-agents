/**
 * Heuristics for "this worker stopped because its provider ran out of quota", applied to the end of
 * the worker's output (orca orchestration worker-read) or to its worker_done body.
 * Only the tail is checked: a quota error is the last thing a stuck agent prints, while code the
 * agent wrote earlier may well mention rate limiting. A false positive only reroutes one task.
 */
const TAIL_CHARS = 2500

const PATTERNS: RegExp[] = [
	/^RATE_LIMITED:/m, // explicit marker our role prompts ask workers to use
	/\brate[ -]limit(ed)?\b/i,
	/\busage limit\b/i,
	/\bquota (exceeded|reached)\b/i,
	/exceeded (your|the) (current )?quota/i,
	/\btoo many requests\b/i,
	/\b(HTTP|status|error)[ :]*429\b/i,
	/\b(usage|request|token|credit)s? (limit|cap) (has been )?reached\b/i,
	/\bout of (credits|premium requests|tokens)\b/i,
	/\bpremium requests? (limit|allowance)\b/i,
	/\btry again (in|at|after) \d/i
]

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/** "try again in 3 hours" / "retry after 45 minutes" -> milliseconds, when the error says so. */
export function retryAfterMs(text: string): number | null {
	const m = text.match(/(?:try again|retry)(?: in| after)? (\d+(?:\.\d+)?) ?(s|sec|seconds?|m|min|minutes?|h|hrs?|hours?|d|days?)\b/i)
	if (!m) return null
	const unit = m[2]!.toLowerCase()[0]!
	return Number(m[1]) * (UNIT_MS[unit] ?? 60_000)
}

export function looksRateLimited(text: string): string | null {
	const tail = text.length > TAIL_CHARS ? text.slice(-TAIL_CHARS) : text
	for (const pattern of PATTERNS) {
		const match = tail.match(pattern)
		if (match) {
			const at = match.index ?? 0
			return tail.slice(Math.max(0, at - 60), at + match[0].length + 60).replace(/\s+/g, ' ').trim()
		}
	}
	return null
}

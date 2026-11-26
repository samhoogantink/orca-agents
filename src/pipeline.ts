import { readFileSync } from 'node:fs'
import { modelVendor, resolveRolePrompt, type Config } from './config.ts'
import { collectStrings, orcaJson, pickString, type OrcaRunner } from './orca.ts'
import { looksRateLimited, retryAfterMs } from './ratelimit.ts'
import { cooldownUntil, route, type Choice, type RouteDecision } from './router.ts'
import { composeSpec, writeSpec } from './spec.ts'
import type { Rule } from './rules.ts'
import { recordDispatch, type DispatchRecord, type State } from './state.ts'
import type { ProviderUsage } from './usage/types.ts'

export type Deps = {
	config: Config
	state: State
	runner: OrcaRunner
	usage: Record<string, ProviderUsage>
	/** Re-probes the given providers (used after a rate limit, to learn when it resets). */
	reprobe?: (providers: string[]) => Promise<Record<string, ProviderUsage>>
	specDir: string
	now: () => number
	log: (line: string) => void
}

export type Attempt = { provider: string; agent: string; model: string | null; error: string }

export type StartResult =
	| { ok: true; record: DispatchRecord; decision: RouteDecision; attempts: Attempt[]; warnings: string[]; specPath?: string }
	| { ok: false; error: string; decision?: RouteDecision; attempts: Attempt[] }

export type StartOptions = {
	role: string
	title?: string
	inputs: { label: string; text: string }[]
	taskId?: string
	worktree?: string
	name?: string
	runId?: string
	depsJson?: string
	avoid?: string[]
	/** Review the work of this dispatch: run in its workspace, always on a model from another vendor. */
	reviewOf?: string
	allowOverBudget?: boolean
	keepOpen?: boolean
	maxAttempts?: number
	/** Project context section for the spec (see project.ts). */
	context?: string
	/** User rules for the spec (see rules.ts). */
	rules?: Rule[]
}

const NEW_WORKTREE = new Set(['new-child', 'new-top-level'])

/** The newest dispatch of the same task, so a reroute (codex -> copilot) is followed to where the work is now. */
export function latestDispatchForTask(state: State, dispatchId: string): DispatchRecord | undefined {
	const rec = state.dispatches[dispatchId]
	if (!rec) return undefined
	return Object.values(state.dispatches)
		.filter((d) => d.taskId === rec.taskId)
		.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
		.pop()
}

/** The model vendor that wrote a dispatch's code, as recorded at start or derived from its provider and model. */
export function authorVendor(config: Config, rec: DispatchRecord): string | null {
	return rec.vendor ?? modelVendor(config.providers[rec.provider], rec.model)
}

const workspaceSelector = (workspace: string) => (workspace.includes(':') ? workspace : `id:${workspace}`)

/** `dispatch:<id>` reuses the workspace an earlier worker ran in, e.g. the reviewer joining the coder. */
export function resolveWorktree(worktree: string, state: State): string {
	if (!worktree.startsWith('dispatch:')) return worktree
	const rec = latestDispatchForTask(state, worktree.slice('dispatch:'.length))
	if (!rec?.workspace) throw new Error(`no recorded workspace for ${worktree}; pass --worktree id:<worktreeId> instead`)
	return workspaceSelector(rec.workspace)
}

function workerStartArgs(o: {
	taskId: string
	choice: Choice
	worktree: string
	name?: string
	runId?: string
	keepOpen?: boolean
	retryOf?: string
}): string[] {
	const args = ['orchestration', 'worker-start', '--task', o.taskId, '--agent', o.choice.agent]
	if (o.choice.model) args.push('--model', o.choice.model)
	if (o.choice.model && o.choice.effort) args.push('--effort', o.choice.effort)
	args.push('--worktree', o.worktree)
	if (o.name && NEW_WORKTREE.has(o.worktree)) args.push('--name', o.name)
	if (o.runId) args.push('--run', o.runId)
	if (o.keepOpen) args.push('--keep-open')
	if (o.retryOf) args.push('--retry-of', o.retryOf)
	return args
}

/** Starts workers down the fallback chain until one launches (a bad model id or missing CLI moves on). */
async function launchWithFallback(
	deps: Deps,
	o: {
		role: string
		taskId: string
		worktree: string
		name?: string
		runId?: string
		keepOpen?: boolean
		retryOf?: string
		avoid: string[]
		reviewOf?: string
		avoidVendors?: string[]
		allowOverBudget?: boolean
		maxAttempts: number
	}
): Promise<StartResult> {
	const attempts: Attempt[] = []
	const avoid = [...o.avoid]
	let retryOf = o.retryOf
	let decision: RouteDecision | undefined
	for (let i = 0; i < o.maxAttempts; i++) {
		decision = route(o.role, deps.config, {
			usage: deps.usage,
			state: deps.state,
			now: deps.now(),
			avoid,
			avoidVendors: o.avoidVendors,
			allowOverBudget: o.allowOverBudget
		})
		const choice = decision.chosen
		if (!choice) {
			return { ok: false, error: `no provider available for role "${o.role}"`, decision, attempts }
		}
		const res = orcaJson(
			deps.runner,
			workerStartArgs({ taskId: o.taskId, choice, worktree: o.worktree, name: o.name, runId: o.runId, keepOpen: o.keepOpen, retryOf })
		)
		if (!res.ok) {
			attempts.push({ provider: choice.provider, agent: choice.agent, model: choice.model, error: res.error })
			deps.log(`worker-start on ${choice.provider} failed: ${res.error}; trying the next candidate`)
			avoid.push(choice.provider)
			retryOf = pickString(res.result, ['dispatchId']) ?? retryOf
			continue
		}
		const r = res.result
		const now = deps.now()
		const record: DispatchRecord = {
			dispatchId: pickString(r, ['dispatchId', 'dispatch.id']) ?? `unknown_${now}`,
			taskId: pickString(r, ['taskId', 'task.id']) ?? o.taskId,
			runId: pickString(r, ['runId', 'run.id']) ?? o.runId,
			role: o.role,
			provider: choice.provider,
			model: choice.model,
			vendor: choice.vendor,
			reviewOf: o.reviewOf,
			avoidVendors: o.avoidVendors?.length ? o.avoidVendors : undefined,
			billing: choice.billing,
			worktree: o.worktree,
			workspace: pickString(r, ['workspace', 'worktree.id', 'worktreeId']),
			terminal: pickString(r, ['terminal', 'terminalHandle']),
			startedAt: new Date(now).toISOString(),
			retryOf: o.retryOf
		}
		recordDispatch(deps.state, record, now)
		const warnings = [...choice.warnings]
		if (r.state && r.state !== 'ready') {
			warnings.push(`worker state is "${r.state}"; do not start it again, wait for its mail (${r.next ?? 'orca orchestration check'})`)
		}
		return { ok: true, record, decision, attempts, warnings }
	}
	return { ok: false, error: `gave up after ${o.maxAttempts} launch attempts`, decision, attempts }
}

export async function startRole(deps: Deps, o: StartOptions): Promise<StartResult> {
	const role = deps.config.roles[o.role]
	if (!role) {
		return { ok: false, error: `unknown role "${o.role}" (known: ${Object.keys(deps.config.roles).join(', ')})`, attempts: [] }
	}
	let avoidVendors: string[] = []
	let worktreeOption = o.worktree
	if (o.reviewOf) {
		const target = latestDispatchForTask(deps.state, o.reviewOf)
		if (!target) return { ok: false, error: `unknown dispatch ${o.reviewOf} for --review-of`, attempts: [] }
		const author = authorVendor(deps.config, target)
		if (!author) {
			return {
				ok: false,
				error: `cannot tell which model vendor wrote the code of ${target.dispatchId} (${target.provider}${target.model ? ` ${target.model}` : ''}); set "vendors" for ${target.provider} in providers.json so the review runs on another vendor`,
				attempts: []
			}
		}
		avoidVendors = [author]
		if (!worktreeOption) {
			if (!target.workspace) {
				return { ok: false, error: `no recorded workspace for ${o.reviewOf}; pass --worktree id:<worktreeId>`, attempts: [] }
			}
			worktreeOption = workspaceSelector(target.workspace)
		}
	}
	const worktree = resolveWorktree(worktreeOption ?? role.worktree, deps.state)

	// Route once before creating anything, so a fully exhausted chain does not leave an orphan task.
	const preview = route(o.role, deps.config, {
		usage: deps.usage,
		state: deps.state,
		now: deps.now(),
		avoid: o.avoid ?? [],
		avoidVendors,
		allowOverBudget: o.allowOverBudget
	})
	if (!preview.chosen) return { ok: false, error: `no provider available for role "${o.role}"`, decision: preview, attempts: [] }

	let taskId = o.taskId
	let specPath: string | undefined
	if (!taskId) {
		const title = o.title ?? o.role
		const spec = composeSpec({
			role: o.role,
			rolePrompt: readFileSync(resolveRolePrompt(deps.config, role), 'utf8'),
			title,
			inputs: o.inputs,
			context: o.context,
			rules: o.rules
		})
		specPath = writeSpec(deps.specDir, o.role, spec, deps.now())
		const args = ['orchestration', 'task-create', '--spec-file', specPath, '--task-title', `${o.role}: ${title}`]
		if (o.depsJson) args.push('--deps', o.depsJson)
		if (o.runId) args.push('--run', o.runId)
		const created = orcaJson(deps.runner, args)
		if (!created.ok) return { ok: false, error: `task-create failed: ${created.error}`, decision: preview, attempts: [] }
		taskId = pickString(created.result, ['taskId', 'task.id', 'id'])
		if (!taskId) return { ok: false, error: 'task-create returned no task id', decision: preview, attempts: [] }
	}

	const result = await launchWithFallback(deps, {
		role: o.role,
		taskId,
		worktree,
		name: o.name,
		runId: o.runId,
		keepOpen: o.keepOpen,
		avoid: o.avoid ?? [],
		reviewOf: o.reviewOf,
		avoidVendors,
		allowOverBudget: o.allowOverBudget,
		maxAttempts: o.maxAttempts ?? 3
	})
	return result.ok ? { ...result, specPath } : result
}

export type RetryOptions = {
	dispatchId: string
	reason: 'auto' | 'rate-limit' | 'other'
	worktree?: string
	stop?: boolean
	avoid?: string[]
	allowOverBudget?: boolean
	/** Needed only for dispatches this tool did not start. */
	role?: string
	taskId?: string
	provider?: string
}

export type RetryResult = StartResult & { rateLimitEvidence: string | null; failedProvider: string }

export async function retryDispatch(deps: Deps, o: RetryOptions): Promise<RetryResult> {
	const known = deps.state.dispatches[o.dispatchId]
	const role = known?.role ?? o.role
	const taskId = known?.taskId ?? o.taskId
	const provider = known?.provider ?? o.provider
	if (!role || !taskId || !provider) {
		return {
			ok: false,
			error: `dispatch ${o.dispatchId} was not started by orca-agents; pass --role, --task and --provider`,
			attempts: [],
			rateLimitEvidence: null,
			failedProvider: provider ?? 'unknown'
		}
	}

	let output = ''
	if (o.reason !== 'other') {
		const read = orcaJson(deps.runner, ['orchestration', 'worker-read', '--dispatch', o.dispatchId, '--limit', '200'])
		if (read.ok) output = collectStrings(read.result).join('\n')
		else deps.log(`worker-read failed (${read.error})`)
	}
	let evidence: string | null = null
	if (o.reason === 'rate-limit') evidence = looksRateLimited(output) ?? 'reported by the coordinator'
	if (o.reason === 'auto') evidence = looksRateLimited(output)

	const now = deps.now()
	if (evidence) {
		const fresh = deps.reprobe ? await deps.reprobe([provider]) : {}
		const usage = fresh[provider] ?? deps.usage[provider]
		if (fresh[provider]) deps.usage[provider] = fresh[provider]
		const providerConfig = deps.config.providers[provider]
		if (providerConfig) {
			deps.state.cooldowns[provider] = {
				until: cooldownUntil(providerConfig, usage, now, retryAfterMs(output.slice(-2500))),
				reason: `rate limited: ${evidence}`.slice(0, 200)
			}
		}
	}

	if (o.stop !== false) {
		const stopped = orcaJson(deps.runner, ['orchestration', 'worker-stop', '--dispatch', o.dispatchId])
		if (!stopped.ok) deps.log(`worker-stop: ${stopped.error} (continuing; it may already be settled)`)
	}

	// Reuse the failed worker's workspace so the next provider continues from its partial work.
	const worktree = o.worktree ?? (known?.workspace ? workspaceSelector(known.workspace) : known?.worktree ?? 'current')

	const result = await launchWithFallback(deps, {
		role,
		taskId,
		worktree,
		runId: known?.runId,
		retryOf: o.dispatchId,
		avoid: [provider, ...(o.avoid ?? [])],
		// A rerouted review keeps its rule: never on the vendor that wrote the code.
		reviewOf: known?.reviewOf,
		avoidVendors: known?.avoidVendors,
		allowOverBudget: o.allowOverBudget,
		maxAttempts: 3
	})
	if (result.ok && known) known.outcome = 'rerouted'
	return { ...result, rateLimitEvidence: evidence, failedProvider: provider }
}

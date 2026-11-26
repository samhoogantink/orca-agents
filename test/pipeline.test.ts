import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { retryDispatch, startRole, type Deps } from '../src/pipeline.ts'
import { REPO_ROOT } from '../src/paths.ts'
import { NOW, fakeRunner, flag, freshState, okUsage, testConfig } from './helpers.ts'

function deps(runner: Deps['runner'], overrides: Partial<Deps> = {}): Deps {
	const config = testConfig()
	config.configDir = join(REPO_ROOT, 'config')
	return {
		config,
		state: freshState(),
		runner,
		usage: {},
		specDir: mkdtempSync(join(tmpdir(), 'oa-spec-')),
		now: () => NOW,
		log: () => {},
		...overrides
	}
}

let seq = 0
const workerStartOk = (args: string[]) => ({
	ok: true,
	result: { dispatchId: `d${++seq}`, taskId: flag(args, 'task'), state: 'ready', workspace: `wt${seq}` }
})

test('start creates the task once, then launches on the routed provider with model, effort and name', async () => {
	const { runner, calls } = fakeRunner({
		'orchestration task-create': () => ({ ok: true, result: { taskId: 'task_1' } }),
		'orchestration worker-start': workerStartOk
	})
	const d = deps(runner)
	const res = await startRole(d, { role: 'junior-backend', title: 'PBI 1', inputs: [{ label: 'Task input', text: 'x' }], name: 'pbi-1', runId: 'run_1' })
	assert.ok(res.ok)
	assert.equal(calls.length, 2)
	const ws = calls[1]!
	assert.deepEqual(
		[flag(ws, 'task'), flag(ws, 'agent'), flag(ws, 'model'), flag(ws, 'effort'), flag(ws, 'worktree'), flag(ws, 'name'), flag(ws, 'run')],
		['task_1', 'codex', 'gpt-x', 'high', 'new-child', 'pbi-1', 'run_1']
	)
	assert.equal(d.state.dispatches[res.record.dispatchId]?.provider, 'codex')
	assert.equal(d.state.ledger.codex?.['2026-11-17'], 1)
})

test('a failed launch moves down the chain and retries the same task', async () => {
	const { runner, calls } = fakeRunner({
		'orchestration task-create': () => ({ ok: true, result: { taskId: 'task_2' } }),
		'orchestration worker-start': (args) =>
			flag(args, 'agent') === 'codex' ? { ok: false, error: 'unknown model gpt-x' } : workerStartOk(args)
	})
	const res = await startRole(deps(runner), { role: 'junior-backend', inputs: [{ label: 'Task input', text: 'x' }] })
	assert.ok(res.ok)
	assert.equal(res.record.provider, 'copilot')
	assert.equal(res.attempts[0]?.provider, 'codex')
	assert.equal(flag(calls[2]!, 'task'), 'task_2')
	assert.equal(flag(calls[2]!, 'model'), undefined, 'copilot gets no --model')
})

test('nothing is created when every provider is blocked', async () => {
	const { runner, calls } = fakeRunner({})
	const state = freshState()
	state.cooldowns.copilot = { until: NOW + 1, reason: 'x' }
	state.cooldowns.pooled = { until: NOW + 1, reason: 'x' }
	const res = await startRole(deps(runner, { state, usage: { codex: okUsage('codex', 100) } }), {
		role: 'junior-backend',
		inputs: [{ label: 'Task input', text: 'x' }]
	})
	assert.equal(res.ok, false)
	assert.equal(calls.length, 0)
})

test('retry after a rate limit cools the provider down, stops the worker and reuses its workspace', async () => {
	const { runner, calls } = fakeRunner({
		'orchestration task-create': () => ({ ok: true, result: { taskId: 'task_3' } }),
		'orchestration worker-start': workerStartOk,
		'orchestration worker-read': () => ({ ok: true, result: { lines: ['thinking...', "You've hit your usage limit. Try again in 2 hours."] } })
	})
	const d = deps(runner)
	const first = await startRole(d, { role: 'junior-backend', inputs: [{ label: 'Task input', text: 'x' }] })
	assert.ok(first.ok)
	const retried = await retryDispatch(d, { dispatchId: first.record.dispatchId, reason: 'auto' })
	assert.ok(retried.ok)
	assert.ok(retried.rateLimitEvidence)
	assert.equal(d.state.cooldowns.codex?.until, NOW + 2 * 3_600_000)
	const verbs = calls.map((c) => c.slice(0, 2).join(' '))
	assert.deepEqual(verbs.slice(2), ['orchestration worker-read', 'orchestration worker-stop', 'orchestration worker-start'])
	const restart = calls.at(-1)!
	assert.equal(flag(restart, 'agent'), 'copilot')
	assert.equal(flag(restart, 'worktree'), `id:${first.record.workspace}`)
	assert.equal(flag(restart, 'retry-of'), first.record.dispatchId)
	assert.equal(flag(restart, 'name'), undefined, 'creation flags are not allowed for an existing worktree')
})

test('a non rate-limit failure avoids the provider once without a cooldown', async () => {
	const { runner } = fakeRunner({
		'orchestration task-create': () => ({ ok: true, result: { taskId: 'task_4' } }),
		'orchestration worker-start': workerStartOk,
		'orchestration worker-read': () => ({ ok: true, result: { text: 'Tests failed: 3 errors.' } })
	})
	const d = deps(runner)
	const first = await startRole(d, { role: 'junior-backend', inputs: [{ label: 'Task input', text: 'x' }] })
	assert.ok(first.ok)
	const retried = await retryDispatch(d, { dispatchId: first.record.dispatchId, reason: 'auto' })
	assert.ok(retried.ok)
	assert.equal(retried.rateLimitEvidence, null)
	assert.equal(d.state.cooldowns.codex, undefined)
	assert.equal(retried.record.provider, 'copilot')
})

test('review-of follows a reroute and runs on another vendor than the one that wrote the code', async () => {
	const { runner, calls } = fakeRunner({
		'orchestration task-create': () => ({ ok: true, result: { taskId: `task_r${++seq}` } }),
		'orchestration worker-start': workerStartOk,
		'orchestration worker-read': () => ({ ok: true, result: { text: 'usage limit reached' } })
	})
	const d = deps(runner)
	const developer = await startRole(d, { role: 'junior-backend', inputs: [{ label: 'Task input', text: 'x' }] })
	assert.ok(developer.ok)
	const rerouted = await retryDispatch(d, { dispatchId: developer.record.dispatchId, reason: 'rate-limit' })
	assert.ok(rerouted.ok)
	assert.equal(rerouted.record.provider, 'copilot')

	const review = await startRole(d, { role: 'reviewer', inputs: [{ label: 'Task input', text: 'review' }], reviewOf: developer.record.dispatchId })
	assert.ok(review.ok)
	// copilot (anthropic) wrote the code now and codex is cooling down, so pooled (google) reviews.
	assert.equal(review.record.provider, 'pooled')
	assert.equal(review.record.vendor, 'google')
	assert.deepEqual(review.record.avoidVendors, ['anthropic'])
	assert.equal(flag(calls.at(-1)!, 'worktree'), `id:${rerouted.record.workspace}`)
})

test('a review with no other vendor available fails before creating a task', async () => {
	const { runner, calls } = fakeRunner({
		'orchestration task-create': () => ({ ok: true, result: { taskId: `task_v${++seq}` } }),
		'orchestration worker-start': workerStartOk
	})
	const d = deps(runner)
	d.config.providers.copilot!.enabled = false
	d.config.providers.pooled!.vendors = { default: 'openai' }
	const developer = await startRole(d, { role: 'junior-backend', inputs: [{ label: 'Task input', text: 'x' }] })
	assert.ok(developer.ok)
	assert.equal(developer.record.vendor, 'openai')
	const before = calls.length

	const review = await startRole(d, { role: 'reviewer', inputs: [{ label: 'Task input', text: 'review' }], reviewOf: developer.record.dispatchId })
	assert.equal(review.ok, false)
	assert.match(review.error, /no provider available/)
	assert.equal(calls.length, before)
})

test('a review fails when the vendor of the code under review is unknown', async () => {
	const { runner } = fakeRunner({
		'orchestration task-create': () => ({ ok: true, result: { taskId: `task_u${++seq}` } }),
		'orchestration worker-start': workerStartOk
	})
	const d = deps(runner)
	delete d.config.providers.codex!.vendors
	d.config.roles['junior-backend']!.candidates = [{ provider: 'codex' }]
	const developer = await startRole(d, { role: 'junior-backend', inputs: [{ label: 'Task input', text: 'x' }] })
	assert.ok(developer.ok)
	const review = await startRole(d, { role: 'reviewer', inputs: [{ label: 'Task input', text: 'review' }], reviewOf: developer.record.dispatchId })
	assert.equal(review.ok, false)
	assert.match(review.error, /cannot tell which model vendor/)
})

test('a rerouted review keeps the vendor rule; a rerouted developer does not get one', async () => {
	const { runner } = fakeRunner({
		'orchestration task-create': () => ({ ok: true, result: { taskId: `task_k${++seq}` } }),
		'orchestration worker-start': workerStartOk,
		'orchestration worker-read': () => ({ ok: true, result: { text: 'usage limit reached' } })
	})
	const d = deps(runner)
	d.config.providers.claude!.enabled = true
	d.config.roles.reviewer!.candidates = [{ provider: 'pooled' }, { provider: 'codex' }, { provider: 'claude' }]
	const developer = await startRole(d, { role: 'junior-backend', inputs: [{ label: 'Task input', text: 'x' }] })
	assert.ok(developer.ok)
	assert.equal(developer.record.provider, 'codex')

	const review = await startRole(d, { role: 'reviewer', inputs: [{ label: 'Task input', text: 'review' }], reviewOf: developer.record.dispatchId })
	assert.ok(review.ok)
	assert.equal(review.record.provider, 'pooled')
	const rerouted = await retryDispatch(d, { dispatchId: review.record.dispatchId, reason: 'rate-limit' })
	assert.ok(rerouted.ok)
	// codex is next in the chain but wrote the code, so claude takes over.
	assert.equal(rerouted.record.provider, 'claude')
	assert.deepEqual(rerouted.record.avoidVendors, ['openai'])
	assert.equal(rerouted.record.reviewOf, developer.record.dispatchId)

	const retriedDev = await retryDispatch(d, { dispatchId: developer.record.dispatchId, reason: 'other' })
	assert.ok(retriedDev.ok)
	assert.equal(retriedDev.record.avoidVendors, undefined)
	assert.equal(retriedDev.record.provider, 'copilot')
})

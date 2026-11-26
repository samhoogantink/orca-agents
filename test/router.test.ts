import assert from 'node:assert/strict'
import { test } from 'node:test'
import { billingClass, modelVendor } from '../src/config.ts'
import { cooldownUntil, evaluate, route } from '../src/router.ts'
import { recordDispatch } from '../src/state.ts'
import { NOW, freshState, okUsage, testConfig, usageWith, win } from './helpers.ts'

test('picks the first candidate under its threshold and passes model + effort', () => {
	const d = route('junior-backend', testConfig(), { usage: { codex: okUsage('codex', 40, 60) }, state: freshState(), now: NOW })
	assert.equal(d.chosen?.provider, 'codex')
	assert.equal(d.chosen?.model, 'gpt-x')
	assert.equal(d.chosen?.effort, 'high')
	assert.equal(d.chosen?.billing, 'included')
})

test('falls back when an included window is at the threshold and extra usage is off', () => {
	const d = route('junior-backend', testConfig(), {
		usage: { codex: okUsage('codex', 20, 85), copilot: okUsage('copilot', 10) },
		state: freshState(),
		now: NOW
	})
	assert.equal(d.chosen?.provider, 'copilot')
	assert.match(d.considered[0]!.reason, /weekly at 85% of included usage \(max 85%/)
	assert.match(d.considered[0]!.reason, /extra usage is off/)
})

test('drops the model for agents Orca cannot pass --model to, with a warning', () => {
	const d = route('junior-backend', testConfig(), { usage: { codex: okUsage('codex', 99) }, state: freshState(), now: NOW })
	assert.equal(d.chosen?.provider, 'copilot')
	assert.equal(d.chosen?.model, null)
	assert.match(d.chosen!.warnings[0]!, /claude-y/)
})

test('skips disabled providers, cooldowns and the local dispatch limit', () => {
	const state = freshState()
	state.cooldowns.copilot = { until: NOW + 60_000, reason: 'test' }
	const config = testConfig()
	let d = route('junior-backend', config, { usage: { codex: okUsage('codex', 99) }, state, now: NOW })
	assert.equal(d.chosen?.provider, 'pooled')
	assert.match(d.considered.find((c) => c.provider === 'claude')!.reason, /disabled/)

	for (const id of ['a', 'b']) {
		recordDispatch(state, { dispatchId: id, taskId: 't', role: 'junior-backend', provider: 'pooled', worktree: 'current', startedAt: '' }, NOW)
	}
	d = route('junior-backend', config, { usage: { codex: okUsage('codex', 99) }, state, now: NOW })
	assert.equal(d.chosen, null)
	assert.match(d.considered.at(-1)!.reason, /2\/2 dispatches today/)
})

test('unknown usage is allowed by default and skipped with unknownUsage=skip', () => {
	const unknown = { codex: { provider: 'codex', status: 'unknown' as const, source: 'x', windows: [], detail: 'timeout', fetchedAt: NOW } }
	assert.equal(route('junior-backend', testConfig(), { usage: unknown, state: freshState(), now: NOW }).chosen?.provider, 'codex')
	const strict = { ...testConfig(), unknownUsage: 'skip' as const }
	const usage = { ...unknown, copilot: okUsage('copilot', 10) }
	assert.equal(route('junior-backend', strict, { usage, state: freshState(), now: NOW }).chosen?.provider, 'copilot')
})

test('billing classes: exact ids, globs and the default', () => {
	const pooled = testConfig().providers.pooled!
	assert.equal(billingClass(pooled, 'auto'), 'fast-models')
	assert.equal(billingClass(pooled, 'Fast-2'), 'fast-models')
	assert.equal(billingClass(pooled, 'gpt-6'), 'other-models')
	assert.equal(billingClass(pooled, 'sonnet-5'), 'included')
	assert.equal(billingClass(pooled, null), 'included')
})

test('pooled: each model class is checked against its own pool and the plan total', () => {
	const config = testConfig()
	const pooled = config.providers.pooled!
	const ctx = (windows: ReturnType<typeof win>[]) => ({ usage: { pooled: usageWith('pooled', windows) }, state: freshState(), now: NOW })
	const pools = [win('plan', 60), win('fast-models', 95, 'fast-models'), win('other-models', 30, 'other-models')]

	// The fast-models pool is exhausted, but other models and the default still have room.
	assert.match(evaluate('pooled', pooled, { model: 'auto' }, config, ctx(pools)).blocked ?? '', /fast-models at 95%/)
	assert.equal(evaluate('pooled', pooled, { model: 'gpt-6' }, config, ctx(pools)).blocked, null)
	assert.equal(evaluate('pooled', pooled, { model: null }, config, ctx(pools)).blocked, null)

	// other-models has its own, lower threshold (80) than the provider-wide one (90).
	const apiHeavy = [win('plan', 60), win('other-models', 82, 'other-models')]
	assert.match(evaluate('pooled', pooled, { model: 'gpt-6' }, config, ctx(apiHeavy)).blocked ?? '', /other-models at 82% .*max 80%/)

	// The plan total caps every class.
	assert.ok(evaluate('pooled', pooled, { model: 'gpt-6' }, config, ctx([win('plan', 91)])).blocked)
})

test('included exhausted: extra usage within its cap is used and billed as extra', () => {
	const config = testConfig()
	config.providers.pooled!.limits.extra = { enabled: true, maxUsedPercent: 50 }
	const pooled = config.providers.pooled!
	const exhausted = [win('plan', 100)]
	const ctx = (extra: Parameters<typeof usageWith>[2]) => ({ usage: { pooled: usageWith('pooled', exhausted, extra) }, state: freshState(), now: NOW })

	const ok = evaluate('pooled', pooled, {}, config, ctx({ available: true, usedPercent: 20, detail: 'on-demand 20%' }))
	assert.equal(ok.blocked, null)
	assert.equal(ok.billing, 'extra')
	assert.match(ok.warnings[0]!, /billed as extra usage/)

	assert.match(evaluate('pooled', pooled, {}, config, ctx({ available: true, usedPercent: 50 })).blocked ?? '', /max 50%/)
	assert.match(evaluate('pooled', pooled, {}, config, ctx({ available: false, detail: 'on-demand usage is off in the provider account' })).blocked ?? '', /off in the provider account/)
	assert.match(evaluate('pooled', pooled, {}, config, ctx(undefined)).blocked ?? '', /fails closed/)
	assert.match(evaluate('pooled', pooled, { allowExtra: false }, config, ctx({ available: true, usedPercent: 1 })).blocked ?? '', /allowExtra: false/)
})

test('copilot: paid-only models and free models', () => {
	const config = testConfig()
	const copilot = config.providers.copilot!
	const usage = (extra: Parameters<typeof usageWith>[2]) => ({ usage: { copilot: usageWith('copilot', [win('monthly', 95)], extra) }, state: freshState(), now: NOW })

	// A free (0x) model ignores the exhausted allowance.
	assert.equal(evaluate('copilot', copilot, { model: 'mini-model' }, config, usage(undefined)).billing, 'free')
	assert.equal(evaluate('copilot', copilot, { model: 'mini-model' }, config, usage(undefined)).blocked, null)

	// A model outside the plan needs extra usage, even with included usage left.
	const roomy = { usage: { copilot: usageWith('copilot', [win('monthly', 10)], { spentUsd: 2 }) }, state: freshState(), now: NOW }
	assert.match(evaluate('copilot', copilot, { model: 'premium-x' }, config, roomy).blocked ?? '', /not included in the plan; extra usage is off/)

	copilot.limits.extra = { enabled: true, maxSpendUsd: 10 }
	const paid = evaluate('copilot', copilot, { model: 'premium-x' }, config, roomy)
	assert.equal(paid.billing, 'extra')
	assert.equal(paid.blocked, null)
	assert.match(evaluate('copilot', copilot, { model: 'premium-x' }, config, usage({ spentUsd: 10 })).blocked ?? '', /\$10\.00 reached the \$10 cap/)
	assert.match(evaluate('copilot', copilot, {}, config, usage({ spentUsd: 4 })).warnings[0] ?? '', /monthly at 95%/)
})

test('avoidVendors is hard: a review never falls back to the vendor that wrote the code', () => {
	const config = testConfig()
	// copilot runs anthropic, codex openai, pooled google.
	let d = route('reviewer', config, { usage: {}, state: freshState(), now: NOW, avoidVendors: ['anthropic'] })
	assert.equal(d.chosen?.provider, 'codex')
	assert.equal(d.chosen?.vendor, 'openai')
	assert.match(d.considered[0]!.reason, /same model vendor \(anthropic\)/)

	// Only copilot (anthropic) is left: no review, not even with allowOverBudget.
	d = route('reviewer', config, {
		usage: { copilot: okUsage('copilot', 95) },
		state: freshState(),
		now: NOW,
		avoid: ['codex', 'pooled'],
		avoidVendors: ['anthropic'],
		allowOverBudget: true
	})
	assert.equal(d.chosen, null)
})

test('avoidVendors skips candidates whose vendor cannot be told', () => {
	const config = testConfig()
	delete config.providers.codex!.vendors
	const d = route('reviewer', config, { usage: {}, state: freshState(), now: NOW, avoidVendors: ['anthropic'] })
	assert.equal(d.chosen?.provider, 'pooled')
	assert.match(d.considered[1]!.reason, /vendor unknown/)
})

test('without avoidVendors, routing ignores vendors (architect and developers)', () => {
	const d = route('junior-backend', testConfig(), { usage: {}, state: freshState(), now: NOW })
	assert.equal(d.chosen?.provider, 'codex')
	assert.equal(d.chosen?.vendor, 'openai')
})

test('modelVendor: vendors map, then well-known model ids, then the default', () => {
	const p = { ...testConfig().providers.pooled!, vendors: { default: 'google', 'house-*': 'openai' } }
	assert.equal(modelVendor(p, 'house-large'), 'openai')
	assert.equal(modelVendor(p, 'claude-sonnet-9'), 'anthropic')
	assert.equal(modelVendor(p, 'gpt-7-codex'), 'openai')
	assert.equal(modelVendor(p, 'o5-mini'), 'openai')
	assert.equal(modelVendor(p, 'other'), 'google')
	assert.equal(modelVendor(p, null), 'google')
	assert.equal(modelVendor({ ...p, vendors: undefined }, null), null)
})

test('allowOverBudget picks the least used included candidate and never a paid-only model', () => {
	const state = freshState()
	state.cooldowns.pooled = { until: NOW + 1, reason: 'x' }
	const config = testConfig()
	let d = route('junior-backend', config, {
		usage: { codex: okUsage('codex', 95), copilot: okUsage('copilot', 91) },
		state,
		now: NOW,
		allowOverBudget: true
	})
	assert.equal(d.chosen?.provider, 'copilot')

	config.roles['junior-backend']!.candidates = [{ provider: 'copilot', model: 'premium-x' }]
	d = route('junior-backend', config, { usage: { copilot: okUsage('copilot', 10) }, state, now: NOW, allowOverBudget: true })
	assert.equal(d.chosen, null)
})

test('cooldown prefers retry-after, then the window reset, then the fixed cooldown', () => {
	const codex = testConfig().providers.codex!
	assert.equal(cooldownUntil(codex, okUsage('codex', 100), NOW, 5 * 60_000), NOW + 5 * 60_000)
	assert.equal(cooldownUntil(codex, okUsage('codex', 100), NOW), NOW + 3_600_000)
	assert.equal(cooldownUntil(codex, okUsage('codex', 10), NOW), NOW + 60 * 60_000)
})

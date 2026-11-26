import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { mapCopilotQuota, probeCopilotQuota, type CopilotQuotaResult } from '../src/usage/copilot-cli.ts'
import { probeCopilotUsage } from '../src/usage/copilot.ts'
import { evaluate } from '../src/router.ts'
import { NOW, freshState, testConfig } from './helpers.ts'

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-copilot-cli.mjs')
const probeOptions = (scenario: string) => ({ command: process.execPath, prefixArgs: [fixture, scenario], timeoutMs: 5000 })

test('copilot CLI: maps account quota and keeps dollar spending unknown', () => {
	const usage = mapCopilotQuota({
		quotaSnapshots: {
			premium_interactions: { remainingPercentage: 70, resetDate: '2026-12-01T00:00:00Z' },
			chat: { remainingPercentage: 0 }, completions: { remainingPercentage: 0 }
		}
	}, NOW)
	assert.deepEqual(usage, {
		provider: 'copilot', status: 'ok', source: 'copilot-cli',
		windows: [{ name: 'monthly', pool: 'included', usedPercent: 30, resetsAt: Date.UTC(2026, 11, 1) }],
		detail: 'premium interactions (Copilot account quota)', fetchedAt: NOW
	})
	const config = testConfig()
	const provider = { ...config.providers.copilot!, limits: { included: { maxUsedPercent: 25 }, extra: { enabled: true, maxSpendUsd: 10 } } }
	const context = { usage: { copilot: usage }, state: freshState(), now: NOW }
	assert.match(evaluate('copilot', provider, {}, config, context).blocked ?? '', /extra usage cannot be measured/)
})

for (const [name, snapshot, expected] of [
	['remaining percentage', { remainingPercentage: 0 }, 100],
	['unused allowance', { remainingPercentage: 100 }, 0],
	['request counts', { entitlementRequests: 300, usedRequests: 60 }, 20],
	['over allowance', { entitlementRequests: 300, usedRequests: 350 }, 100],
	['invalid percentage with valid counts', { remainingPercentage: NaN, entitlementRequests: 300, usedRequests: 60 }, 20]
] as const) {
	test(`copilot CLI: ${name}`, () => {
		const usage = mapCopilotQuota({ quotaSnapshots: { premium_interactions: { ...snapshot, resetDate: 'invalid' } } }, NOW)
		assert.equal(usage.status, 'ok')
		assert.deepEqual(usage.windows, [{ name: 'monthly', pool: 'included', usedPercent: expected, resetsAt: null }])
		assert.equal(usage.extra, undefined)
	})
}

for (const snapshot of [{ isUnlimitedEntitlement: true }, { entitlementRequests: -1 }]) {
	test(`copilot CLI: unlimited entitlement ${JSON.stringify(snapshot)}`, () => {
		assert.deepEqual(mapCopilotQuota({ quotaSnapshots: { premium_interactions: snapshot } }, NOW), {
			provider: 'copilot', status: 'ok', source: 'copilot-cli', windows: [],
			detail: 'unlimited premium interactions', fetchedAt: NOW
		})
	})
}

const unavailableQuotas: [string, CopilotQuotaResult | null][] = [
	['null response', null], ['missing snapshots', {}], ['null snapshots', { quotaSnapshots: null }],
	['missing premium quota', { quotaSnapshots: { chat: { remainingPercentage: 100 } } }],
	...[
		null, {}, { remainingPercentage: '75' }, { remainingPercentage: Infinity },
		{ remainingPercentage: -5 }, { remainingPercentage: 101 },
		{ entitlementRequests: 0, usedRequests: 0, remainingPercentage: 100 },
		{ entitlementRequests: 300, usedRequests: -1 }
	].map((snapshot): [string, CopilotQuotaResult] => [JSON.stringify(snapshot), { quotaSnapshots: { premium_interactions: snapshot } }])
]
for (const [name, quota] of unavailableQuotas) {
	test(`copilot CLI: unknown quota for ${name}`, () => {
		assert.deepEqual(mapCopilotQuota(quota, NOW), {
			provider: 'copilot', status: 'unknown', source: 'copilot-cli', windows: [],
			detail: 'no usable premium_interactions quota reported', fetchedAt: NOW
		})
	})
}

for (const scenario of ['success', 'legacy']) {
	test(`copilot CLI: account-only RPC over framed stdio (${scenario})`, async () => {
		const { fetchedAt, ...usage } = await probeCopilotQuota(probeOptions(scenario))
		assert.ok(fetchedAt > 0)
		assert.deepEqual(usage, {
			provider: 'copilot', status: 'ok', source: 'copilot-cli',
			windows: [{ name: 'monthly', pool: 'included', usedPercent: 25, resetsAt: Date.UTC(2026, 11, 1) }],
			detail: 'premium interactions (Copilot account quota)'
		})
	})
}

for (const [scenario, error] of [
	['auth-error', /Not authenticated/], ['unsupported', /Method not found/],
	['invalid-json', /invalid Copilot RPC JSON/], ['invalid-header', /invalid Copilot RPC Content-Length/],
	['exit', /Copilot exited \(2\): cannot start Copilot/], ['timeout', /timed out/]
] as const) {
	test(`copilot CLI: reports unknown on ${scenario}`, async () => {
		const usage = await probeCopilotQuota({ ...probeOptions(scenario), timeoutMs: scenario === 'timeout' ? 300 : 5000 })
		assert.equal(usage.status, 'unknown')
		assert.equal(usage.source, 'copilot-cli')
		assert.deepEqual(usage.windows, [])
		assert.equal(usage.extra, undefined)
		assert.match(usage.detail ?? '', error)
	})
}

test('copilot CLI: a missing executable returns unknown', async () => {
	const usage = await probeCopilotQuota({ command: 'definitely-not-copilot-xyz', timeoutMs: 1000 })
	assert.equal(usage.status, 'unknown')
	assert.match(usage.detail ?? '', /ENOENT/)
})

test('copilot: new probe skips gh; existing billing configs fall back to CLI', async () => {
	const options = probeOptions('success')
	const usage = await probeCopilotUsage({ probe: 'copilot-cli' }, {
		...options, gh: () => { throw new Error('CLI quota must not require gh') }
	})
	assert.equal(usage.status, 'ok')
	const fallback = await probeCopilotUsage({ probe: 'github-billing', monthlyAllowance: 300 }, {
		...options, gh: () => ({ code: 1, stdout: '', stderr: 'HTTP 404' })
	})
	assert.deepEqual(fallback.windows, usage.windows)
	assert.equal(fallback.source, 'copilot-cli')
	assert.equal(fallback.extra, undefined)
	const failed = await probeCopilotUsage({ probe: 'github-billing', monthlyAllowance: 300 }, {
		...probeOptions('auth-error'), gh: () => ({ code: 1, stdout: '', stderr: 'HTTP 404' })
	})
	assert.equal(failed.status, 'unknown')
	assert.match(failed.detail ?? '', /Not authenticated.*billing unavailable:.*HTTP 404/)
})

test('copilot: successful legacy billing still reports measured dollar spending', async () => {
	const usage = await probeCopilotUsage({ probe: 'github-billing', monthlyAllowance: 300 }, {
		command: 'must-not-launch-copilot',
		gh: (args) => ({ code: 0, stderr: '', stdout: args[1] === 'user' ? 'sam' : JSON.stringify({ usageItems: [{ product: 'Copilot', grossQuantity: 120, netAmount: 2 }] }) })
	})
	assert.equal(usage.status, 'ok')
	assert.equal(usage.source, 'github-billing')
	assert.equal(usage.extra?.spentUsd, 2)
})

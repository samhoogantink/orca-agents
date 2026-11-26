import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { mapClaudeFeed } from '../src/usage/claude.ts'
import { mapCodexRateLimits, probeCodex } from '../src/usage/codex.ts'
import { mapBillingReport, probeCopilot, startOfNextMonthUtc } from '../src/usage/copilot.ts'
import { collectUsage } from '../src/usage/index.ts'
import { recordDispatch } from '../src/state.ts'
import { NOW, freshState, testConfig } from './helpers.ts'

test('codex: classifies 5h and weekly windows and converts reset seconds', () => {
	const u = mapCodexRateLimits(
		{
			rateLimits: {
				primary: { usedPercent: 42.5, windowDurationMins: 300, resetsAt: 1_800_000_000 },
				secondary: { usedPercent: 91, windowDurationMins: 10_080, resetsAt: 1_800_500_000 },
				planType: 'plus'
			}
		},
		NOW
	)
	assert.equal(u.status, 'ok')
	assert.deepEqual(
		u.windows.map((w) => [w.name, w.usedPercent, w.resetsAt]),
		[
			['session', 42.5, 1_800_000_000_000],
			['weekly', 91, 1_800_500_000_000]
		]
	)
	assert.equal(u.detail, 'plan: plus')
})

test('codex: workspace seats with only a monthly spend cap', () => {
	const u = mapCodexRateLimits({ rateLimits: { individualLimit: { remainingPercent: 30, resetsAt: 1_800_000_000 } } }, NOW)
	assert.equal(u.windows[0]?.name, 'monthly')
	assert.equal(u.windows[0]?.usedPercent, 70)
})

test('codex: no windows means unknown, not zero', () => {
	assert.equal(mapCodexRateLimits({ rateLimits: null }, NOW).status, 'unknown')
})

test('copilot: sums Copilot usage items against the allowance', () => {
	const u = mapBillingReport(
		{
			usageItems: [
				{ product: 'Copilot', model: 'A', grossQuantity: 120, netQuantity: 0, netAmount: 0 },
				{ product: 'Copilot', model: 'B', grossQuantity: 30, netQuantity: 25, netAmount: 1 },
				{ product: 'Actions', grossQuantity: 999, netAmount: 50 }
			]
		},
		300,
		NOW
	)
	assert.equal(u.windows[0]?.usedPercent, 50)
	assert.equal(u.windows[0]?.pool, 'included')
	assert.equal(u.windows[0]?.resetsAt, Date.UTC(2026, 11, 1))
	assert.equal(u.extra?.spentUsd, 1, 'only Copilot items count as extra spend')
	assert.equal(startOfNextMonthUtc(Date.UTC(2026, 11, 31)), Date.UTC(2027, 0, 1))
})

test('copilot: calls gh with the billing path and degrades to unknown on errors', () => {
	const calls: string[][] = []
	const gh = (args: string[]) => {
		calls.push(args)
		if (args[1] === 'user') return { code: 0, stdout: 'sam\n', stderr: '' }
		return { code: 0, stdout: JSON.stringify({ usageItems: [{ product: 'Copilot', grossQuantity: 270 }] }), stderr: '' }
	}
	const u = probeCopilot({ probe: 'github-billing', unit: 'ai_credit', monthlyAllowance: 300 }, gh)
	assert.equal(u.windows[0]?.usedPercent, 90)
	assert.ok(calls[1]!.includes('/users/sam/settings/billing/ai_credit/usage'))

	const failing = () => ({ code: 1, stdout: '', stderr: 'HTTP 403' })
	assert.equal(probeCopilot({ probe: 'github-billing', monthlyAllowance: 300 }, failing).status, 'unknown')
	assert.equal(probeCopilot({ probe: 'github-billing' }, gh).status, 'unknown')
})

test('claude: reads the status-line feed and rejects stale feeds', () => {
	const feed = {
		writtenAt: NOW - 60_000,
		rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1_800_000_000 }, seven_day: { used_percentage: 41.2 } }
	}
	const u = mapClaudeFeed(feed, NOW)
	assert.deepEqual(u.windows.map((w) => w.name), ['session', 'weekly'])
	assert.equal(mapClaudeFeed({ ...feed, writtenAt: NOW - 7 * 3_600_000 }, NOW).status, 'unknown')
})

test('codex: speaks the app-server JSON-RPC handshake end to end', async () => {
	const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-codex-app-server.mjs')
	const u = await probeCodex({ command: process.execPath, prefixArgs: [fixture], timeoutMs: 10_000 })
	assert.equal(u.status, 'ok', u.detail)
	assert.deepEqual(u.windows.map((w) => [w.name, w.usedPercent]), [['session', 12], ['weekly', 88]])
})

test('codex: a missing binary degrades to unknown', async () => {
	const u = await probeCodex({ command: 'definitely-not-codex-xyz', timeoutMs: 5_000 })
	assert.equal(u.status, 'unknown')
})

test('collectUsage caches each provider for five minutes and recomputes the ledger every time', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'oa-usage-'))
	const feed = join(dir, 'claude.json')
	const write = (pct: number) =>
		writeFileSync(feed, JSON.stringify({ writtenAt: Date.now(), rate_limits: { five_hour: { used_percentage: pct } } }))
	const config = testConfig()
	config.providers.claude!.enabled = true
	config.providers.local = { ...config.providers.codex!, usage: { probe: 'ledger' }, limits: { maxDispatchesPerDay: 5 } }
	const only = ['claude', 'local']
	const state = freshState()
	write(10)
	let u = await collectUsage(config, state, { claudeFeedPath: feed, only })
	assert.equal(u.claude?.windows[0]?.usedPercent, 10)
	write(50)
	u = await collectUsage(config, state, { claudeFeedPath: feed, only })
	assert.equal(u.claude?.windows[0]?.usedPercent, 10, 'served from cache')
	recordDispatch(state, { dispatchId: 'x', taskId: 't', role: 'junior-backend', provider: 'local', worktree: 'current', startedAt: '' }, Date.now())
	assert.match(u.local?.detail ?? '', /^0 dispatches/)
	u = await collectUsage(config, state, { claudeFeedPath: feed, only, refresh: true })
	assert.equal(u.claude?.windows[0]?.usedPercent, 50)
	assert.match(u.local?.detail ?? '', /^1 dispatches/)
})

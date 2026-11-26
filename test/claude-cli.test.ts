import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { mapClaudePrintResult, mapClaudeUsageText, parseResetTime, probeClaudeCli, type ClaudeCliProbe } from '../src/usage/claude-cli.ts'
import { CLAUDE_CLI_PAUSE_MS, collectUsage } from '../src/usage/index.ts'
import { evaluate } from '../src/router.ts'
import { unknownUsage } from '../src/usage/types.ts'
import { NOW, freshState, testConfig } from './helpers.ts'

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude-cli.mjs')
const run = (scenario: string, timeoutMs = 10_000) =>
	probeClaudeCli({ command: process.execPath, prefixArgs: [fixture, scenario], timeoutMs })

// NOW is 2026-11-17 22:00 UTC, 23:00 in Amsterdam.
for (const [text, expected] of [
	['7:39pm (Europe/Amsterdam)', Date.UTC(2026, 10, 18, 18, 39)],
	['11:30pm (Europe/Amsterdam)', Date.UTC(2026, 10, 17, 22, 30)],
	['Nov 30, 8:59am (Europe/Amsterdam)', Date.UTC(2026, 10, 30, 7, 59)],
	['Jul 1, 9am (Europe/Amsterdam)', Date.UTC(2027, 6, 1, 7, 0)],
	['Jan 2, 1am (America/New_York)', Date.UTC(2027, 0, 2, 6, 0)],
	['Nov 20, 12am (UTC)', Date.UTC(2026, 10, 20, 0, 0)],
	['Nov 30, 8:59am (Not/AZone)', Date.UTC(2026, 10, 30, 8, 59)],
	['November 30 at 8:59 AM', Date.UTC(2026, 10, 30, 8, 59)],
	['soon', null],
	['Foo 30, 8am', null]
] as const) {
	test(`claude CLI: reset time "${text}"`, () => {
		assert.equal(parseResetTime(text, NOW, 'UTC'), expected)
	})
}

test('claude CLI: maps session, all-models week and model-scoped weeks', () => {
	const usage = mapClaudeUsageText([
		'You are currently using your subscription to power your Claude Code usage',
		'',
		'Current session: 5% used · resets Nov 18, 7:39pm (Europe/Amsterdam)',
		'Current week (all models): 2.5% used · resets Nov 30, 8:59am (Europe/Amsterdam)',
		'Current week (Sonnet only): 10% used',
		'  69%  See what fills your context · run /context'
	].join('\r\n'), NOW)
	assert.deepEqual(usage, {
		provider: 'claude', status: 'ok', source: 'claude-cli', detail: 'claude -p /usage', fetchedAt: NOW,
		windows: [
			{ name: 'session', pool: 'included', usedPercent: 5, resetsAt: Date.UTC(2026, 10, 18, 18, 39) },
			{ name: 'weekly', pool: 'included', usedPercent: 2.5, resetsAt: Date.UTC(2026, 10, 30, 7, 59) },
			{ name: 'weekly (Sonnet only)', pool: 'sonnet-only', usedPercent: 10, resetsAt: null }
		]
	})
})

test('claude CLI: text without limits is unknown, not zero', () => {
	const usage = mapClaudeUsageText('\nYou are using an API key. /usage is only available for subscription plans.\n', NOW)
	assert.equal(usage.status, 'unknown')
	assert.match(usage.detail ?? '', /no plan limits in \/usage output: You are using an API key/)
})

test('claude CLI: a billed or failed print result is unknown', () => {
	const billed = mapClaudePrintResult({ result: 'ok', num_turns: 1, total_cost_usd: 0.0042 }, NOW)
	assert.equal(billed.usage.status, 'unknown')
	assert.equal(billed.billedUsd, 0.0042)
	assert.match(billed.usage.detail ?? '', /sent \/usage to the model \(1 turns, \$0\.0042\)/)
	assert.equal(mapClaudePrintResult({ result: 'Current session: 1% used', num_turns: 1, total_cost_usd: 0 }, NOW).billedUsd, 0)
	const failed = mapClaudePrintResult({ result: 'Not logged in', is_error: true, num_turns: 0, total_cost_usd: 0 }, NOW)
	assert.equal(failed.billedUsd, undefined)
	assert.match(failed.usage.detail ?? '', /claude -p failed: Not logged in/)
	assert.match(mapClaudePrintResult({}, NOW).usage.detail ?? '', /no result text/)
})

test('claude CLI: runs claude -p /usage with the cost-guard flags', async () => {
	const { usage, billedUsd } = await run('success')
	assert.equal(usage.status, 'ok', usage.detail)
	assert.equal(billedUsd, undefined)
	assert.deepEqual(usage.windows.map((w) => [w.name, w.pool, w.usedPercent]), [
		['session', 'included', 5], ['weekly', 'included', 62], ['weekly (Sonnet only)', 'sonnet-only', 10]
	])
})

test('claude CLI: process failures degrade to unknown', async () => {
	assert.equal((await run('billed')).billedUsd, 0.004)
	assert.match((await run('error')).usage.detail ?? '', /Not logged in/)
	assert.match((await run('garbage')).usage.detail ?? '', /exited \(3\) without JSON: boom/)
	assert.match((await run('hang', 1500)).usage.detail ?? '', /timed out after 1500ms/)
	const missing = await probeClaudeCli({ command: 'definitely-not-claude-xyz', timeoutMs: 10_000 })
	assert.equal(missing.usage.status, 'unknown')
})

function claudeConfig() {
	const config = testConfig()
	config.providers.claude = { ...config.providers.claude!, enabled: true, usage: { probe: 'claude-cli' } }
	return config
}

const okProbe = async (): Promise<ClaudeCliProbe> => ({
	usage: mapClaudeUsageText('Current session: 30% used\nCurrent week (all models): 90% used', NOW)
})

test('claude CLI: collectUsage prefers the CLI and the router reads its windows', async () => {
	const config = claudeConfig()
	const usage = await collectUsage(config, freshState(), { claudeFeedPath: '/nonexistent', only: ['claude'], claudeCli: okProbe })
	assert.equal(usage.claude?.source, 'claude-cli')
	const ev = evaluate('claude', config.providers.claude!, {}, config, { usage, state: freshState(), now: NOW })
	assert.match(ev.blocked ?? '', /weekly at 90% of included usage/)
})

test('claude CLI: falls back to a fresh status-line feed when the CLI cannot tell', async () => {
	const feed = join(mkdtempSync(join(tmpdir(), 'oa-claude-')), 'feed.json')
	writeFileSync(feed, JSON.stringify({ writtenAt: Date.now(), rate_limits: { five_hour: { used_percentage: 12 } } }))
	const unknown = async (): Promise<ClaudeCliProbe> => ({ usage: unknownUsage('claude', 'claude-cli', 'timed out after 45000ms') })
	const usage = await collectUsage(claudeConfig(), freshState(), { claudeFeedPath: feed, only: ['claude'], claudeCli: unknown })
	assert.equal(usage.claude?.status, 'ok')
	assert.equal(usage.claude?.source, 'claude-statusline')
	assert.equal(usage.claude?.windows[0]?.usedPercent, 12)
	assert.equal(usage.claude?.detail, 'status-line feed (timed out after 45000ms)')
})

test('claude CLI: a billed call pauses the CLI probe for a day', async () => {
	const config = claudeConfig()
	const state = freshState()
	let calls = 0
	const billed = async (): Promise<ClaudeCliProbe> => {
		calls++
		return mapClaudePrintResult({ result: 'hm', num_turns: 1, total_cost_usd: 0.003 }, NOW)
	}
	const deps = { claudeFeedPath: '/nonexistent', only: ['claude'], claudeCli: billed, now: NOW }
	let usage = await collectUsage(config, state, deps)
	assert.equal(usage.claude?.status, 'unknown')
	assert.match(usage.claude?.detail ?? '', /^claude-cli paused for 24h: Claude Code sent \/usage to the model/)
	assert.equal(state.probePauses?.['claude-cli']?.until, NOW + CLAUDE_CLI_PAUSE_MS)

	usage = await collectUsage(config, state, { ...deps, refresh: true, now: NOW + 3_600_000 })
	assert.equal(calls, 1, 'paused: the CLI is not run again')
	assert.match(usage.claude?.detail ?? '', /^claude-cli paused until 2026-11-18T22:00:00.000Z/)

	await collectUsage(config, state, { ...deps, refresh: true, now: NOW + CLAUDE_CLI_PAUSE_MS + 1 })
	assert.equal(calls, 2, 'the pause expires')
})

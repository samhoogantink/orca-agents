import assert from 'node:assert/strict'
import { test } from 'node:test'
import { collectStrings, orcaJson, pickString, resolveOrcaBin } from '../src/orca.ts'
import { quoteForCmd } from '../src/proc.ts'
import { looksRateLimited, retryAfterMs } from '../src/ratelimit.ts'
import { composeSpec } from '../src/spec.ts'

test('rate-limit detection looks at the tail and ignores code that mentions rate limiting', () => {
	assert.ok(looksRateLimited("■ You've hit your usage limit. Upgrade or try again in 2 hours."))
	assert.ok(looksRateLimited('Error: 429 Too Many Requests'))
	assert.ok(looksRateLimited('RATE_LIMITED: copilot said premium request limit reached'))
	assert.equal(looksRateLimited('Added RateLimiter middleware and rateLimitOptions to Program.cs. All tests pass.'), null)
	const early = `rate limit exceeded\n${'x'.repeat(5000)}\nDone, all tests pass.`
	assert.equal(looksRateLimited(early), null)
})

test('retry-after parsing', () => {
	assert.equal(retryAfterMs('try again in 3 hours'), 3 * 3_600_000)
	assert.equal(retryAfterMs('Retry after 45 minutes'), 45 * 60_000)
	assert.equal(retryAfterMs('try again in 30s'), 30_000)
	assert.equal(retryAfterMs('please try again later'), null)
})

test('orca executable resolution follows the Orca skill rules', () => {
	assert.equal(resolveOrcaBin({ ORCA_CLI_COMMAND: 'orca.exe' }, 'win32'), 'orca.exe')
	assert.equal(resolveOrcaBin({ ORCA_DEV_REPO_ROOT: '/x' }, 'darwin'), 'orca-dev')
	assert.equal(resolveOrcaBin({}, 'linux'), 'orca-ide')
	assert.equal(resolveOrcaBin({}, 'win32'), 'orca')
	assert.equal(resolveOrcaBin({ ORCA_AGENTS_ORCA_BIN: 'my-orca', ORCA_CLI_COMMAND: 'x' }, 'linux'), 'my-orca')
})

test('orcaJson parses receipts and surfaces error lines', () => {
	const ok = orcaJson(() => ({ code: 0, stdout: '{"ok":true,"result":{"dispatchId":"d1"}}\n', stderr: '' }), ['x'])
	assert.deepEqual(ok, { ok: true, result: { dispatchId: 'd1' } })
	const bad = orcaJson(() => ({ code: 1, stdout: '', stderr: 'heartbeat\nerror: runtime_unavailable: busy\n' }), ['x'])
	assert.deepEqual(bad, { ok: false, error: 'error: runtime_unavailable: busy', result: undefined })
	assert.equal(pickString({ run: { id: 'r1' } }, ['runId', 'run.id']), 'r1')
	assert.deepEqual(collectStrings({ a: ['x', { b: 'y' }], c: 1 }), ['x', 'y'])
})

test('cmd.exe quoting keeps JSON and spaces intact', () => {
	assert.equal(quoteForCmd('task_abc'), 'task_abc')
	assert.equal(quoteForCmd('C:\\Users\\me\\spec.md'), 'C:\\Users\\me\\spec.md')
	assert.equal(quoteForCmd('PBI 1234'), '"PBI 1234"')
	assert.equal(quoteForCmd('["task_1"]'), '"[\\"task_1\\"]"')
	assert.equal(quoteForCmd(''), '""')
})

test('spec contains role prompt, inputs and the reporting contract', () => {
	const spec = composeSpec({
		role: 'junior-backend',
		rolePrompt: 'You implement one PBI.',
		title: 'PBI 1234',
		inputs: [{ label: 'Task input', text: 'Add a health endpoint.' }]
	})
	assert.match(spec, /^# PBI 1234/)
	assert.match(spec, /You implement one PBI\./)
	assert.match(spec, /## Task input\n\nAdd a health endpoint\./)
	assert.match(spec, /RATE_LIMITED:/)
})

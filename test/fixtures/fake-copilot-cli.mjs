// Account-only Copilot RPC server. Rejects session/prompt calls and checks the launch flags.
import assert from 'node:assert/strict'

const [scenario, ...args] = process.argv.slice(2)
assert.deepEqual(args, ['--headless', '--stdio', '--no-auto-update', '--log-level', 'none'])
if (scenario === 'exit') {
	process.stderr.write('cannot start Copilot')
	process.exit(2)
}
let buffer = Buffer.alloc(0)
let connected = false
const encodeMessage = (message) => {
	const body = JSON.stringify({ jsonrpc: '2.0', ...message })
	return Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}
const writeResponse = (message) => process.stdout.write(encodeMessage(message))
process.stdin.on('end', () => process.exit(0))
process.stdin.on('data', (chunk) => {
	buffer = Buffer.concat([buffer, chunk])
	while (true) {
		const headerEnd = buffer.indexOf('\r\n\r\n')
		if (headerEnd === -1) return
		const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, headerEnd).toString())[1])
		const end = headerEnd + 4 + length
		if (buffer.length < end) return
		const request = JSON.parse(buffer.subarray(headerEnd + 4, end).toString())
		buffer = buffer.subarray(end)
		assert.deepEqual(request.params, {})
		if (scenario === 'timeout') continue
		if (request.method === 'connect') {
			assert.equal(request.id, 1)
			if (scenario === 'legacy') {
				writeResponse({ id: request.id, error: { code: -32601, message: 'Method not found' } })
			} else {
				connected = true
				writeResponse({ id: request.id, result: { protocolVersion: 4 } })
			}
		} else if (request.method === 'ping' && scenario === 'legacy') {
			assert.equal(request.id, 2)
			connected = true
			writeResponse({ id: request.id, result: { protocolVersion: 3 } })
		} else {
			assert.equal(request.method, 'account.getQuota', 'never create a session or send an AI prompt')
			assert.equal(request.id, 3)
			assert.equal(connected, true)
			if (scenario === 'auth-error') {
				writeResponse({ id: request.id, error: { code: -32603, message: 'Not authenticated' } })
			} else if (scenario === 'unsupported') {
				writeResponse({ id: request.id, error: { code: -32601, message: 'Method not found' } })
			} else if (scenario === 'invalid-json') {
				process.stdout.write('Content-Length: 1\r\n\r\n{')
			} else if (scenario === 'invalid-header') {
				process.stdout.write('Content-Length: invalid\r\n\r\n')
			} else {
				const response = encodeMessage({
					id: request.id,
					result: {
						quotaSnapshots: {
							premium_interactions: { entitlementRequests: 300, usedRequests: 75, remainingPercentage: 75, resetDate: '2026-12-01T00:00:00Z' },
							chat: { isUnlimitedEntitlement: true }
						}
					}
				})
				// A UTF-8 notification and response share a chunk; the final body is fragmented.
				process.stdout.write(Buffer.concat([encodeMessage({ method: 'notice', params: { text: 'quota €' } }), response.subarray(0, response.length - 3)]))
				setImmediate(() => process.stdout.write(response.subarray(response.length - 3)))
			}
		}
	}
})

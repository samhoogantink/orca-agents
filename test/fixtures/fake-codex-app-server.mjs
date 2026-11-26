// Minimal stand-in for `codex app-server`: answers initialize and account/rateLimits/read over
// newline-delimited JSON-RPC on stdio, and checks it was started with the read-only probe flags.
const args = process.argv.slice(2)
if (args.at(-1) !== 'app-server' || !args.includes('read-only')) {
	process.stderr.write(`unexpected args: ${args.join(' ')}\n`)
	process.exit(2)
}
let buffer = ''
let initialized = false
process.stdin.on('data', (chunk) => {
	buffer += chunk
	let idx
	while ((idx = buffer.indexOf('\n')) !== -1) {
		const msg = JSON.parse(buffer.slice(0, idx))
		buffer = buffer.slice(idx + 1)
		const reply = (result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`)
		if (msg.method === 'initialize') {
			process.stdout.write('not json noise\n')
			reply({ userAgent: 'fake' })
		} else if (msg.method === 'initialized') {
			initialized = true
		} else if (msg.method === 'account/rateLimits/read') {
			if (!initialized) {
				process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -1, message: 'not initialized' } })}\n`)
				continue
			}
			reply({
				rateLimits: {
					primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_800_000_000 },
					secondary: { usedPercent: 88, windowDurationMins: 10_080, resetsAt: 1_800_400_000 },
					planType: 'plus'
				}
			})
		}
	}
})

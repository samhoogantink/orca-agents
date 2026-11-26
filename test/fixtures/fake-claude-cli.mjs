// Stand-in for `claude -p /usage --output-format json`. Checks the probe flags and prints the
// print-mode JSON that Claude Code returns for a locally handled slash command.
const [scenario, ...args] = process.argv.slice(2)
const expected = [
	'-p', '/usage', '--output-format', 'json', '--model', 'haiku', '--max-budget-usd', '0.01',
	'--tools', '', '--strict-mcp-config', '--no-session-persistence'
]
if (JSON.stringify(args) !== JSON.stringify(expected)) {
	process.stderr.write(`unexpected args: ${JSON.stringify(args)}\n`)
	process.exit(2)
}
const text = [
	'You are currently using your subscription to power your Claude Code usage',
	'',
	'Current session: 5% used · resets 7:39pm (Europe/Amsterdam)',
	'Current week (all models): 62% used · resets Nov 30, 8:59am (Europe/Amsterdam)',
	'Current week (Sonnet only): 10% used',
	'',
	"What's contributing to your usage?"
].join('\n')
const base = { type: 'result', subtype: 'success', is_error: false, num_turns: 0, total_cost_usd: 0 }
switch (scenario) {
	case 'success':
		process.stdout.write(JSON.stringify({ ...base, result: text }))
		break
	case 'billed':
		process.stdout.write(JSON.stringify({ ...base, num_turns: 1, total_cost_usd: 0.004, result: 'I cannot run /usage.' }))
		break
	case 'error':
		process.stdout.write(JSON.stringify({ ...base, is_error: true, result: 'Not logged in · Please run /login' }))
		process.exit(1)
		break
	case 'garbage':
		process.stderr.write('boom')
		process.exit(3)
		break
	case 'hang':
		setTimeout(() => {}, 60_000)
		break
}

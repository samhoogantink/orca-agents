import { runSync, type RunResult } from './proc.ts'

/**
 * Picks the Orca executable the way Orca's own skills do:
 * ORCA_CLI_COMMAND (managed WSL sessions) > orca-dev in a dev checkout > orca-ide on Linux
 * (bare `orca` there is usually the GNOME screen reader) > orca.
 * ORCA_AGENTS_ORCA_BIN overrides everything.
 */
export function resolveOrcaBin(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
	const override = env.ORCA_AGENTS_ORCA_BIN?.trim() || env.ORCA_CLI_COMMAND?.trim()
	if (override) return override
	if (env.ORCA_DEV_REPO_ROOT) return 'orca-dev'
	if (platform === 'linux') return 'orca-ide'
	return 'orca'
}

export type OrcaRunner = (args: string[]) => RunResult

export const realRunner = (bin: string): OrcaRunner => (args) => runSync(bin, args, { timeoutMs: 10 * 60_000 })

let dryCounter = 0

/** Prints each Orca command instead of running it and answers with plausible receipts. */
export const dryRunner = (bin: string, log: (line: string) => void): OrcaRunner => (args) => {
	log(`$ ${[bin, ...args].map((a) => (/[\s"'[\]{}]/.test(a) ? JSON.stringify(a) : a)).join(' ')}`)
	const n = `${Date.now().toString(36)}${++dryCounter}`
	const flag = (name: string) => {
		const i = args.indexOf(`--${name}`)
		return i >= 0 ? args[i + 1] : undefined
	}
	const verb = args.slice(0, 2).join(' ')
	let result: Record<string, unknown> = {}
	if (verb === 'orchestration task-create') result = { taskId: `task_dry${n}` }
	if (verb === 'orchestration worker-start') {
		result = {
			dispatchId: `dispatch_dry${n}`,
			taskId: flag('task') ?? `task_dry${n}`,
			state: 'ready',
			agent: flag('agent'),
			model: flag('model'),
			workspace: `wt_dry${n}`,
			terminal: `term_dry${n}`
		}
	}
	if (verb === 'orchestration worker-read') result = { text: process.env.ORCA_AGENTS_DRY_READ ?? '' }
	return { code: 0, stdout: `${JSON.stringify({ ok: true, result })}\n`, stderr: '' }
}

export type OrcaOk = { ok: true; result: any }
export type OrcaErr = { ok: false; error: string; result?: any }

export function orcaJson(runner: OrcaRunner, args: string[]): OrcaOk | OrcaErr {
	const res = runner([...args, '--json'])
	if (res.error) return { ok: false, error: res.error }
	const line = res.stdout.trim().split('\n').filter(Boolean).pop() ?? ''
	let parsed: any = null
	try {
		parsed = JSON.parse(line)
	} catch {
		// Older builds or failures may print text; fall through to the exit code.
	}
	if (res.code === 0 && parsed?.ok !== false) return { ok: true, result: parsed?.result ?? parsed ?? {} }
	const stderr = res.stderr.trim().split('\n').filter((l) => l.startsWith('error:')).pop() ?? res.stderr.trim()
	return { ok: false, error: stderr || parsed?.error?.message || `exit code ${res.code}`, result: parsed?.result }
}

/** Finds an id in a receipt without depending on one exact shape (receipts differ across Orca versions). */
export function pickString(obj: any, paths: string[]): string | undefined {
	for (const path of paths) {
		const value = path.split('.').reduce<any>((o, k) => (o == null ? undefined : o[k]), obj)
		if (typeof value === 'string' && value) return value
	}
	return undefined
}

/** Flattens every string in a JSON value, for scanning worker output whatever its shape. */
export function collectStrings(value: unknown, out: string[] = []): string[] {
	if (typeof value === 'string') out.push(value)
	else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out))
	else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectStrings(v, out))
	return out
}

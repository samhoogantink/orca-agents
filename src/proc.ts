import { spawn, spawnSync, type ChildProcess } from 'node:child_process'

export type RunResult = { code: number | null; stdout: string; stderr: string; error?: string }

const isWindows = process.platform === 'win32'

/**
 * Quote one argument for cmd.exe. npm-installed CLIs (codex, copilot, orca shims) are .cmd files on
 * Windows, which Node can only start through a shell, so arguments must be quoted by hand there.
 * Uses the MSVCRT rules node.exe applies when it parses argv. Best effort: % and ! are not escaped.
 */
export function quoteForCmd(arg: string): string {
	if (arg === '') return '""'
	if (/^[\w@+=:,./\\-]+$/.test(arg)) return arg
	const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')
	return `"${escaped}"`
}

function shellCommand(cmd: string, args: string[]): string {
	return [cmd, ...args].map(quoteForCmd).join(' ')
}

export function runSync(
	cmd: string,
	args: string[],
	opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {}
): RunResult {
	const common = {
		encoding: 'utf8' as const,
		timeout: opts.timeoutMs ?? 120_000,
		env: opts.env ?? process.env,
		cwd: opts.cwd,
		maxBuffer: 32 * 1024 * 1024
	}
	const res = isWindows
		? spawnSync(shellCommand(cmd, args), { ...common, shell: true, windowsHide: true })
		: spawnSync(cmd, args, common)
	return {
		code: res.status,
		stdout: res.stdout ?? '',
		stderr: res.stderr ?? '',
		error: res.error ? res.error.message : undefined
	}
}

export function spawnPiped(cmd: string, args: string[], opts: { cwd?: string } = {}): ChildProcess {
	return isWindows
		? spawn(shellCommand(cmd, args), { shell: true, windowsHide: true, stdio: 'pipe', cwd: opts.cwd })
		: spawn(cmd, args, { stdio: 'pipe', cwd: opts.cwd })
}

export function killTree(child: ChildProcess): void {
	if (child.exitCode !== null || child.pid === undefined) return
	if (isWindows) {
		spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
	} else {
		child.kill('SIGTERM')
	}
}

export function commandExists(cmd: string): boolean {
	const res = isWindows ? runSync('where', [cmd], { timeoutMs: 10_000 }) : runSync('sh', ['-c', `command -v ${cmd}`], { timeoutMs: 10_000 })
	return res.code === 0
}

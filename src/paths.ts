import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Root of this repository (where config/ and roles/ live). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Machine-local state: cooldowns, dispatch records, usage cache, generated specs. */
export function stateHome(env: NodeJS.ProcessEnv = process.env): string {
	return env.ORCA_AGENTS_HOME?.trim() || join(homedir(), '.orca-agents')
}

export const statePaths = (home: string) => ({
	state: join(home, 'state.json'),
	specs: join(home, 'specs'),
	feeds: join(home, 'feeds'),
	claudeFeed: join(home, 'feeds', 'claude-rate-limits.json'),
	userConfig: join(home, 'config'),
	rules: join(home, 'rules')
})

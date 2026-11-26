import { constants, copyFileSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { REPO_ROOT, stateHome, statePaths } from './paths.ts'

export type ProbeKind = 'codex-app-server' | 'copilot-cli' | 'github-billing' | 'claude-cli' | 'claude-statusline' | 'ledger'

export type UsageConfig = {
	probe: ProbeKind
	/** github-billing only. */
	unit?: 'premium_request' | 'ai_credit'
	monthlyAllowance?: number
}

/**
 * How a model is billed:
 * - free: unmetered on this plan (no budget checks, only cooldowns)
 * - included: draws from the plan's included usage
 * - extra: never part of the plan, always billed on top
 * - any other name: a named included pool reported by the probe
 */
export type BillingClass = string

export type Limits = {
	included?: {
		/** Stop using included usage at this percentage (applies to every included pool). */
		maxUsedPercent?: number
		/** Per-pool override, e.g. { "other-models": 70 }. */
		pools?: Record<string, number>
	}
	/** Usage outside the plan: overage, on-demand, and models the plan does not include. */
	extra?: {
		enabled: boolean
		/** Monthly cap in USD, checked when the probe reports spend in USD (Copilot). */
		maxSpendUsd?: number
		/** Cap as a percentage of the spend limit set in the provider's own account. */
		maxUsedPercent?: number
	}
	/** Local guard counted from dispatches this tool started. */
	maxDispatchesPerDay?: number
}

export type ProviderConfig = {
	enabled: boolean
	orcaAgent: string
	/** Executable name(s), when they differ from the Orca agent id. */
	cli?: string | string[]
	supportsModelFlag: boolean
	usage: UsageConfig
	limits: Limits
	/** Model id or glob (`gpt-*`) -> billing class. `default` covers unlisted and null models. */
	models?: Record<string, BillingClass>
	/**
	 * Model id or glob -> vendor of the model (openai, anthropic, google, ...). `default` covers the
	 * agent's own default model. Reviews must run on a model from another vendor than the code's author.
	 */
	vendors?: Record<string, string>
	cooldownMinutes: number
}

export type Candidate = {
	provider: string
	model?: string | null
	effort?: string | null
	/** false: this role may never cause extra (paid) usage on this candidate. */
	allowExtra?: boolean
}

export type RoleConfig = {
	prompt: string
	worktree: string
	candidates: Candidate[]
}

export type Config = {
	unknownUsage: 'allow' | 'skip'
	providers: Record<string, ProviderConfig>
	roles: Record<string, RoleConfig>
	configDir: string
}

function stripMeta<T>(value: T): T {
	if (Array.isArray(value)) return value.map(stripMeta) as T
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {}
		for (const [k, v] of Object.entries(value)) {
			if (!k.startsWith('$')) out[k] = stripMeta(v)
		}
		return out as T
	}
	return value
}

function readJson(path: string): any {
	return stripMeta(JSON.parse(readFileSync(path, 'utf8')))
}

/**
 * Config lookup order:
 * 1. ORCA_AGENTS_CONFIG_DIR
 * 2. ~/.orca-agents/config (personal overrides that stay out of git)
 * 3. <repo>/config
 * Files missing from the chosen folder come from findConfigFile.
 */
export function resolveConfigDir(env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env.ORCA_AGENTS_CONFIG_DIR?.trim()
	if (explicit) return explicit
	const personal = statePaths(stateHome(env)).userConfig
	if (existsSync(join(personal, 'providers.json'))) return personal
	return join(REPO_ROOT, 'config')
}

/**
 * The first file that exists among <configDir>/<name>.json and <repo>/config/<name>.json.
 * When neither exists, <repo>/config/<name>.json is created as a copy of the committed
 * <repo>/config/<name>.template.json. The local .json files are gitignored.
 */
export function findConfigFile(
	configDir: string,
	name: 'providers' | 'roles' | 'rules',
	repoConfigDir: string = join(REPO_ROOT, 'config')
): string {
	const repoFile = join(repoConfigDir, `${name}.json`)
	const found = [join(configDir, `${name}.json`), repoFile].find(file => existsSync(file))
	if (found) return found
	const template = join(repoConfigDir, `${name}.template.json`)
	if (!existsSync(template)) throw new Error(`no ${name} config found; ${repoFile} is missing and there is no ${template} to copy`)
	try {
		copyFileSync(template, repoFile, constants.COPYFILE_EXCL)
	} catch (error: any) {
		// Another run may have created it in the meantime; keep that copy.
		if (error?.code !== 'EEXIST') throw error
	}
	return repoFile
}

/**
 * The folders listed in rules.json (an array of paths), checked for user rules after
 * ~/.orca-agents/rules. `~` is the home folder; relative paths are relative to rules.json.
 */
export function parseRuleFolders(value: unknown, file: string): string[] {
	if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v.trim())) {
		throw new Error(`${file}: expected an array of folder paths, like ["~/team-rules"]`)
	}
	return [...new Set(value.map((v: string) => {
		const path = v.trim()
		if (path === '~' || /^~[\\/]/.test(path)) return join(homedir(), path.slice(1))
		return resolve(dirname(file), path)
	}))]
}

export function loadRuleFolders(env: NodeJS.ProcessEnv = process.env): string[] {
	const file = findConfigFile(resolveConfigDir(env), 'rules')
	return parseRuleFolders(JSON.parse(readFileSync(file, 'utf8')), file)
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const configDir = resolveConfigDir(env)
	const providersFile = readJson(findConfigFile(configDir, 'providers'))
	const rolesFile = readJson(findConfigFile(configDir, 'roles'))
	const providers: Record<string, ProviderConfig> = {}
	for (const [name, p] of Object.entries<any>(providersFile.providers ?? {})) {
		providers[name] = { ...p, limits: p.limits ?? {} }
	}
	const config: Config = {
		unknownUsage: providersFile.unknownUsage === 'skip' ? 'skip' : 'allow',
		providers,
		roles: rolesFile.roles ?? {},
		configDir
	}
	validateConfig(config)
	return config
}

export function validateConfig(config: Config): void {
	for (const [name, p] of Object.entries(config.providers)) {
		const extra = p.limits.extra
		if (extra?.enabled && extra.maxSpendUsd === undefined && extra.maxUsedPercent === undefined) {
			throw new Error(`provider "${name}": limits.extra.enabled needs maxSpendUsd or maxUsedPercent, so extra spend has a cap`)
		}
	}
	for (const [roleName, role] of Object.entries(config.roles)) {
		if (!role.candidates?.length) throw new Error(`role "${roleName}" has no candidates`)
		for (const c of role.candidates) {
			if (!config.providers[c.provider]) {
				throw new Error(`role "${roleName}" references unknown provider "${c.provider}"`)
			}
			if (c.effort && !c.model) {
				throw new Error(`role "${roleName}": effort needs a model (Orca requires --model with --effort)`)
			}
		}
	}
}

function globMatch(pattern: string, value: string): boolean {
	const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i')
	return re.test(value)
}

/** Looks a model up in a model map: exact ids win over globs; `default` is left to the caller. */
function lookupModel<T>(map: Record<string, T>, model: string | null | undefined): T | undefined {
	if (!model) return undefined
	const exact = Object.entries(map).find(([k]) => k.toLowerCase() === model.toLowerCase())
	if (exact) return exact[1]
	return Object.entries(map).find(([k]) => k !== 'default' && k.includes('*') && globMatch(k, model))?.[1]
}

/** Billing class for a model on a provider; exact ids win over globs, `default` covers the rest. */
export function billingClass(provider: ProviderConfig, model: string | null | undefined): BillingClass {
	const map = provider.models ?? {}
	return lookupModel(map, model) ?? map.default ?? 'included'
}

/** Well-known model id prefixes, used when `vendors` does not list the model. */
const KNOWN_VENDORS: [RegExp, string][] = [
	[/^(claude|opus|sonnet|haiku)\b/i, 'anthropic'],
	[/^(gpt|codex|o\d)\b/i, 'openai'],
	[/^gemini\b/i, 'google'],
	[/^grok\b/i, 'xai']
]

/**
 * Who made the model a candidate runs: the `vendors` map, then a well-known model id prefix, then
 * `vendors.default` for the agent's own default model. Null when it cannot be told.
 */
export function modelVendor(provider: ProviderConfig | undefined, model: string | null | undefined): string | null {
	if (!provider) return null
	const map = provider.vendors ?? {}
	const listed = lookupModel(map, model)
	if (listed) return listed.toLowerCase()
	const known = model ? KNOWN_VENDORS.find(([re]) => re.test(model))?.[1] : undefined
	return known ?? map.default?.toLowerCase() ?? null
}

export function resolveRolePrompt(config: Config, role: RoleConfig): string {
	if (isAbsolute(role.prompt)) return role.prompt
	const besideConfig = join(config.configDir, '..', role.prompt)
	return existsSync(besideConfig) ? besideConfig : join(REPO_ROOT, role.prompt)
}

/** Candidate executable names for a provider's CLI, in order of preference. */
export const executablesFor = (provider: ProviderConfig): string[] =>
	provider.cli === undefined ? [provider.orcaAgent] : Array.isArray(provider.cli) ? provider.cli : [provider.cli]

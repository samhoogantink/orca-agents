import { parseArgs } from 'node:util'
import { executablesFor, loadConfig, loadRuleFolders, type Config } from './config.ts'
import { dryRunner, orcaJson, realRunner, resolveOrcaBin, type OrcaRunner } from './orca.ts'
import { retryDispatch, startRole, type Deps, type StartResult } from './pipeline.ts'
import { commandExists } from './proc.ts'
import { codeHostLabel, detectProject, parseWorkItem, projectContext, TRACKER_NAMES, type ProjectInfo, type WorkItem } from './project.ts'
import { loadRules, rulesFor, rulesSection, ruleVerdict, type Rule, type RuleSet } from './rules.ts'
import { evaluate, includedThreshold, route, type RouteDecision } from './router.ts'
import { readInputs } from './spec.ts'
import { loadState, saveState, type State } from './state.ts'
import { stateHome, statePaths } from './paths.ts'
import { collectUsage } from './usage/index.ts'
import type { ProviderUsage } from './usage/types.ts'

const HELP = `orca-agents: usage-aware, multi-provider workers on top of Orca orchestration

Usage:
  orca-agents usage [--refresh] [--json]
  orca-agents usage check --provider <id> [--model <id>] [--max <percent>] [--strict]
  orca-agents route --role <role> [--avoid <ids>] [--allow-over-budget] [--json]
  orca-agents project [--item <ref>] [--role <role>] [--json]
  orca-agents rules [--role <role>] [--json]
  orca-agents start --role <role> [--item <ref>] [--title <text>] [--input <text>]... [--input-file <path>]...
                    [--task <taskId>] [--worktree current|new-child|id:<id>|dispatch:<id>] [--name <name>]
                    [--run <runId>] [--deps <json>] [--avoid <ids>] [--review-of <dispatchId>]
                    [--allow-over-budget] [--keep-open]
                    [--dry-run] [--json]
  orca-agents retry --dispatch <dispatchId> [--reason auto|rate-limit|other] [--worktree <selector>]
                    [--no-stop] [--avoid <ids>] [--allow-over-budget] [--dry-run] [--json]
  orca-agents cooldown list | set --provider <id> [--minutes <n>] [--reason <text>] | clear [--provider <id>]
  orca-agents doctor

Work items: a URL, ABC-123 (Jira), AB#123 (Azure Boards), owner/repo#12 or #12 (GitHub or GitHub Enterprise).
The tracker and code host are detected from the project in the current folder; \`orca-agents project\` shows
what was found. GitHub Enterprise hosts come from ORCA_AGENTS_GITHUB_HOSTS, GH_HOST and gh's signed-in hosts.
Roles and fallback chains live in config/roles.json, providers and thresholds in config/providers.json.
State (cooldowns, dispatches, usage cache) lives in ${stateHome()} (override with ORCA_AGENTS_HOME).
User rules (Markdown with name/repository/description/roles/active frontmatter) live in ${statePaths(stateHome()).rules}
and in the folders listed in config/rules.json.`

function csv(value: string | undefined): string[] {
	return value ? value.split(',').map((s) => s.trim()).filter(Boolean) : []
}

function fmtReset(ms: number | null): string {
	if (!ms) return ''
	const mins = Math.round((ms - Date.now()) / 60_000)
	if (mins <= 0) return 'reset due'
	if (mins < 120) return `resets in ${mins}m`
	return mins < 48 * 60 ? `resets in ${Math.round(mins / 60)}h` : `resets in ${Math.round(mins / 1440)}d`
}

function printUsage(usage: Record<string, ProviderUsage>, config: Config, state: State): void {
	for (const [name, u] of Object.entries(usage)) {
		const p = config.providers[name]
		const ev = p ? evaluate(name, p, undefined, config, { usage, state, now: Date.now() }) : null
		const verdict =
			u.status === 'disabled'
				? 'disabled'
				: ev?.blocked
					? `BLOCKED: ${ev.blocked}`
					: ev?.billing === 'extra'
						? 'available, billed as extra usage'
						: 'available'
		console.log(`${name.padEnd(9)} ${u.status.padEnd(8)} ${verdict}`)
		const windows = u.windows
			.map((w) => {
				const max = p ? includedThreshold(p, w.pool) : undefined
				return `${w.name} ${w.usedPercent.toFixed(0)}%${max !== undefined ? `/${max}%` : ''}${w.resetsAt ? ` (${fmtReset(w.resetsAt)})` : ''}`
			})
			.join(', ')
		if (windows) console.log(`          included: ${windows}`)
		if (p && u.status !== 'disabled') {
			const caps = p.limits.extra
			const capText = caps?.enabled
				? [caps.maxSpendUsd !== undefined ? `$${caps.maxSpendUsd}` : '', caps.maxUsedPercent !== undefined ? `${caps.maxUsedPercent}% of account limit` : '']
						.filter(Boolean)
						.join(', ')
				: 'off'
			console.log(`          extra: ${u.extra?.detail ?? 'not measured'} [cap: ${capText}]`)
		}
		if (u.detail) console.log(`          ${u.detail} [${u.source}]`)
	}
}

/** User rules from ~/.orca-agents/rules, then from the folders in rules.json. */
function loadUserRules(): RuleSet {
	return loadRules(statePaths(stateHome()).rules, loadRuleFolders())
}

function printSkipped(set: RuleSet): void {
	for (const s of set.skipped) console.error(`note: rule ${s.path} skipped: ${s.reason}`)
}

function printProject(p: ProjectInfo, set: RuleSet, item?: WorkItem, role?: string): void {
	console.log(`project       ${p.root}`)
	console.log(`code host     ${codeHostLabel(p.codeHost)}`)
	if (p.codeHost.kind === 'other') {
		console.log('              (for a GitHub Enterprise Server, add its host to ORCA_AGENTS_GITHUB_HOSTS or sign in with gh auth login --hostname <host>)')
	}
	console.log(`tracker       ${p.tracker ? TRACKER_NAMES[p.tracker] : 'not detected'} (${p.confidence} confidence)`)
	console.log(`scores        ${Object.entries(p.scores).map(([t, n]) => `${t} ${n}`).join(', ')}`)
	for (const [i, e] of p.evidence.entries()) console.log(`${i ? '             ' : 'evidence     '} ${e.tracker}: ${e.source} ${e.detail} [${e.weight}]`)
	if (p.jira.sites.length || p.jira.keys.length) console.log(`jira          sites ${p.jira.sites.join(', ') || '-'}; keys ${p.jira.keys.slice(0, 5).join(', ') || '-'}`)
	if (p.azure) console.log(`azure         ${p.azure.organization}/${p.azure.project}`)
	if (p.docs.length) console.log(`docs          ${p.docs.map((d) => d.url).join(', ')}`)
	console.log(`instructions  ${p.instructionFiles.join(', ') || 'none found'}`)
	if (item) console.log(`work item     ${item.id} (${TRACKER_NAMES[item.tracker]})${item.url ? ` ${item.url}` : ''}`)
	const applied = rulesFor(set.rules, p.codeHost, role)
	const forRoles = (r: Rule) => (role || !r.roles ? '' : ` [${r.roles.join(', ')}]`)
	console.log(`rules         ${applied.map((r) => `${r.name}${forRoles(r)}`).join(', ') || 'none'}${role ? ` for ${role}` : ''} (from ${set.dirs.join(', ')})`)
	printSkipped(set)
	const rules = rulesSection(applied)
	console.log(`
Workers receive:

${projectContext(p, item)}${rules ? `

${rules}` : ''}`)
}

function printRules(set: RuleSet, p: ProjectInfo, knownRoles: string[], role?: string): void {
	for (const [i, dir] of set.dirs.entries()) console.log(`${i ? '             ' : 'rules folders'} ${dir}`)
	console.log(`project       ${p.root}${p.codeHost.kind === 'github' || p.codeHost.kind === 'azure-devops' ? ` (${codeHostLabel(p.codeHost)})` : ''}`)
	if (!set.rules.length && !set.skipped.length) console.log('no rules found')
	for (const r of set.rules) {
		const verdict = ruleVerdict(r, p.codeHost, role)
		console.log(`${verdict === 'applies' ? '->' : '  '} ${r.name}  ${verdict}${r.repository ? ` [${r.repository}]` : ' [all repositories]'} [${r.roles?.join(', ') ?? 'all roles'}]`)
		if (r.description) console.log(`     ${r.description}`)
		const unknown = r.roles?.filter((name) => !knownRoles.includes(name)) ?? []
		if (unknown.length) console.log(`     warning: unknown role${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} (known: ${knownRoles.join(', ')})`)
		console.log(`     ${r.path}`)
	}
	for (const s of set.skipped) console.log(`   skipped ${s.path}: ${s.reason}`)
}

function printDecision(d: RouteDecision): void {
	for (const c of d.considered) {
		const mark = c.verdict === 'chosen' ? '->' : '  '
		const billing = c.verdict === 'chosen' && c.billing ? ` [${c.billing}]` : ''
		console.log(`${mark} ${c.provider.padEnd(9)}${c.model ? ` ${c.model}` : ''}  ${c.verdict}${billing}: ${c.reason}`)
	}
	for (const w of d.chosen?.warnings ?? []) console.log(`   warning: ${w}`)
}

function printStart(result: StartResult, json: boolean): number {
	if (json) {
		console.log(JSON.stringify(result, null, 2))
		return result.ok ? 0 : 2
	}
	if (result.decision) printDecision(result.decision)
	for (const a of result.attempts) console.log(`   launch failed on ${a.provider}: ${a.error}`)
	if (!result.ok) {
		console.error(`error: ${result.error}`)
		return 2
	}
	const r = result.record
	const runsOn = [r.model, r.vendor].filter(Boolean).join(', ')
	console.log(`started ${r.role} on ${r.provider}${runsOn ? ` (${runsOn})` : ''}, billed as ${r.billing ?? 'included'} usage`)
	console.log(`  task ${r.taskId}  dispatch ${r.dispatchId}${r.workspace ? `  workspace ${r.workspace}` : ''}`)
	for (const w of result.warnings) console.log(`  warning: ${w}`)
	if (result.specPath) console.log(`  spec ${result.specPath}`)
	return 0
}

async function main(argv: string[]): Promise<number> {
	const [command, ...rest] = argv
	if (!command || command === 'help' || command === '--help' || command === '-h') {
		console.log(HELP)
		return 0
	}

	if (command === 'project') {
		const { values } = parseArgs({ args: rest, options: { item: { type: 'string' }, role: { type: 'string' }, json: { type: 'boolean' } } })
		const project = detectProject(process.cwd())
		const item = values.item ? parseWorkItem(values.item, project) : undefined
		const set = loadUserRules()
		if (values.json) {
			const rules = rulesFor(set.rules, project.codeHost, values.role)
			const section = rulesSection(rules)
			console.log(JSON.stringify({ ...project, item, rules, skippedRules: set.skipped, context: projectContext(project, item), rulesSection: section }, null, 2))
		} else printProject(project, set, item, values.role)
		return 0
	}

	if (command === 'rules') {
		const { values } = parseArgs({ args: rest, options: { role: { type: 'string' }, json: { type: 'boolean' } } })
		const project = detectProject(process.cwd())
		const set = loadUserRules()
		const knownRoles = Object.keys(loadConfig().roles)
		if (values.json) {
			const rules = set.rules.map((r) => ({ ...r, verdict: ruleVerdict(r, project.codeHost, values.role) }))
			console.log(JSON.stringify({ dirs: set.dirs, role: values.role, knownRoles, rules, skipped: set.skipped }, null, 2))
		} else printRules(set, project, knownRoles, values.role)
		return 0
	}

	const home = stateHome()
	const paths = statePaths(home)
	// Dry runs keep their own state file, so you can rehearse start -> retry without touching real state.
	const dryRun = rest.includes('--dry-run') || process.env.ORCA_AGENTS_DRY_RUN === '1'
	if (dryRun) paths.state = paths.state.replace(/\.json$/, '.dry-run.json')
	const config = loadConfig()
	const state = loadState(paths.state)
	const probeDeps = { claudeFeedPath: paths.claudeFeed }

	if (command === 'usage') {
		const sub = rest[0] === 'check' ? rest.shift() : undefined
		const { values } = parseArgs({
			args: rest,
			options: {
				refresh: { type: 'boolean' },
				json: { type: 'boolean' },
				provider: { type: 'string' },
				max: { type: 'string' },
				model: { type: 'string' },
				strict: { type: 'boolean' },
				'dry-run': { type: 'boolean' }
			}
		})
		if (sub === 'check') {
			// Exit 0 = go, 1 = over budget. Meant for `orca automations create --precheck`.
			const name = values.provider
			if (!name || !config.providers[name]) throw new Error('usage check needs --provider <id> from providers.json')
			const usage = await collectUsage(config, state, { ...probeDeps, only: [name], refresh: values.refresh })
			saveState(paths.state, state)
			const provider = structuredClone(config.providers[name]!)
			if (values.max) {
				const max = Number(values.max)
				if (!Number.isFinite(max)) throw new Error('--max must be a number (percent)')
				provider.limits.included = { ...provider.limits.included, maxUsedPercent: max, pools: {} }
			}
			const strictConfig = values.strict ? { ...config, unknownUsage: 'skip' as const } : config
			const ev = evaluate(name, provider, { model: values.model ?? null }, strictConfig, { usage, state, now: Date.now() })
			console.log(ev.blocked ? `${name}: blocked: ${ev.blocked}` : `${name}: ok (${ev.billing} usage)`)
			return ev.blocked ? 1 : 0
		}
		const usage = await collectUsage(config, state, { ...probeDeps, refresh: values.refresh, only: csv(values.provider).length ? csv(values.provider) : undefined })
		saveState(paths.state, state)
		if (values.json) console.log(JSON.stringify(usage, null, 2))
		else printUsage(usage, config, state)
		return 0
	}

	if (command === 'route') {
		const { values } = parseArgs({
			args: rest,
			options: {
				role: { type: 'string' },
				avoid: { type: 'string' },
				refresh: { type: 'boolean' },
				'allow-over-budget': { type: 'boolean' },
				json: { type: 'boolean' },
				'dry-run': { type: 'boolean' }
			}
		})
		if (!values.role) throw new Error('route needs --role')
		const usage = await collectUsage(config, state, { ...probeDeps, refresh: values.refresh })
		saveState(paths.state, state)
		const decision = route(values.role, config, {
			usage,
			state,
			now: Date.now(),
			avoid: csv(values.avoid),
			allowOverBudget: values['allow-over-budget']
		})
		if (values.json) console.log(JSON.stringify(decision, null, 2))
		else printDecision(decision)
		return decision.chosen ? 0 : 2
	}

	if (command === 'start' || command === 'retry') {
		const { values } = parseArgs({
			args: rest,
			options: {
				role: { type: 'string' },
				item: { type: 'string' },
				title: { type: 'string' },
				input: { type: 'string', multiple: true },
				'input-file': { type: 'string', multiple: true },
				task: { type: 'string' },
				worktree: { type: 'string' },
				name: { type: 'string' },
				run: { type: 'string' },
				deps: { type: 'string' },
				avoid: { type: 'string' },
				'allow-over-budget': { type: 'boolean' },
				'keep-open': { type: 'boolean' },
				'review-of': { type: 'string' },
				dispatch: { type: 'string' },
				reason: { type: 'string' },
				provider: { type: 'string' },
				'no-stop': { type: 'boolean' },
				refresh: { type: 'boolean' },
				'dry-run': { type: 'boolean' },
				json: { type: 'boolean' }
			}
		})
		const bin = resolveOrcaBin()
		const log = (line: string) => console.error(line)
		const runner: OrcaRunner = dryRun ? dryRunner(bin, log) : realRunner(bin)
		const usage = await collectUsage(config, state, { ...probeDeps, refresh: values.refresh })
		const deps: Deps = {
			config,
			state,
			runner,
			usage,
			reprobe: (only) => collectUsage(config, state, { ...probeDeps, only, refresh: true }),
			specDir: paths.specs,
			now: Date.now,
			log
		}

		let result: StartResult
		if (command === 'start') {
			if (!values.role) throw new Error('start needs --role')
			const inputs = readInputs(values.input ?? [], values['input-file'] ?? [])
			if (!values.task && !inputs.length) throw new Error('start needs --input or --input-file (or an existing --task)')
			// The spec carries what this project uses for work items and code, detected from its own files.
			const project = detectProject(process.cwd())
			const item = values.item ? parseWorkItem(values.item, project) : undefined
			if (!item && project.confidence !== 'high') {
				log(`note: tracker ${project.tracker ? `${TRACKER_NAMES[project.tracker]} (${project.confidence} confidence)` : 'not detected'}; pass --item <ref> or run \`orca-agents project\``)
			}
			// User rules from ~/.orca-agents/rules and rules.json: global ones and those for this repository and role.
			const ruleSet = loadUserRules()
			for (const s of ruleSet.skipped) log(`note: rule ${s.path} skipped: ${s.reason}`)
			const rules = rulesFor(ruleSet.rules, project.codeHost, values.role)
			if (rules.length) log(`rules: ${rules.map((r) => r.name).join(', ')}`)
			result = await startRole(deps, {
				role: values.role,
				title: values.title ?? item?.id,
				context: projectContext(project, item),
				rules,
				inputs,
				taskId: values.task,
				worktree: values.worktree,
				name: values.name ?? item?.slug,
				runId: values.run,
				depsJson: values.deps,
				avoid: csv(values.avoid),
				reviewOf: values['review-of'],
				allowOverBudget: values['allow-over-budget'],
				keepOpen: values['keep-open']
			})
		} else {
			if (!values.dispatch) throw new Error('retry needs --dispatch')
			const reason = (values.reason ?? 'auto') as 'auto' | 'rate-limit' | 'other'
			if (!['auto', 'rate-limit', 'other'].includes(reason)) throw new Error('--reason must be auto, rate-limit or other')
			const retried = await retryDispatch(deps, {
				dispatchId: values.dispatch,
				reason,
				worktree: values.worktree,
				stop: !values['no-stop'],
				avoid: csv(values.avoid),
				allowOverBudget: values['allow-over-budget'],
				role: values.role,
				taskId: values.task,
				provider: values.provider
			})
			if (!values.json) {
				console.log(
					retried.rateLimitEvidence
						? `${retried.failedProvider} looks rate limited (${retried.rateLimitEvidence}); cooling it down`
						: `${retried.failedProvider} failed for another reason; avoiding it for this retry only`
				)
			}
			result = retried
		}
		saveState(paths.state, state)
		return printStart(result, Boolean(values.json))
	}

	if (command === 'cooldown') {
		const sub = rest.shift() ?? 'list'
		const { values } = parseArgs({
			args: rest,
			options: {
				provider: { type: 'string' },
				minutes: { type: 'string' },
				reason: { type: 'string' },
				'dry-run': { type: 'boolean' }
			}
		})
		if (sub === 'set') {
			const name = values.provider
			if (!name || !config.providers[name]) throw new Error('cooldown set needs --provider <id>')
			const minutes = Number(values.minutes ?? config.providers[name]!.cooldownMinutes)
			state.cooldowns[name] = { until: Date.now() + minutes * 60_000, reason: values.reason ?? 'set by hand' }
		} else if (sub === 'clear') {
			if (values.provider) delete state.cooldowns[values.provider]
			else state.cooldowns = {}
		} else if (sub !== 'list') {
			throw new Error(`unknown cooldown command "${sub}"`)
		}
		saveState(paths.state, state)
		const active = Object.entries(state.cooldowns).filter(([, c]) => c.until > Date.now())
		if (!active.length) console.log('no active cooldowns')
		for (const [name, c] of active) console.log(`${name.padEnd(9)} until ${new Date(c.until).toISOString()}  ${c.reason}`)
		return 0
	}

	if (command === 'doctor') {
		const bin = resolveOrcaBin()
		const checks: [string, boolean, string][] = []
		checks.push([`orca CLI (${bin})`, commandExists(bin), 'Orca Settings > Orca CLI registers it'])
		if (commandExists(bin)) {
			const status = orcaJson(realRunner(bin), ['status'])
			checks.push(['orca runtime reachable', status.ok, status.ok ? '' : status.ok === false ? status.error : ''])
		}
		for (const [name, p] of Object.entries(config.providers)) {
			if (!p.enabled) continue
			const exes = executablesFor(p)
			const found = exes.find((exe) => commandExists(exe))
			checks.push([`${name} CLI (${found ?? exes.join(' or ')})`, found !== undefined, `needed for provider "${name}"`])
		}
		for (const [label, ok, hint] of checks) console.log(`${ok ? 'ok  ' : 'MISS'} ${label}${!ok && hint ? `  -> ${hint}` : ''}`)
		const project = detectProject(process.cwd())
		console.log(`project: ${project.root} (tracker ${project.tracker ?? 'not detected'}, ${project.confidence} confidence; code host ${project.codeHost.kind})`)
		console.log(`config: ${config.configDir}`)
		console.log(`state:  ${home}`)
		const ruleSet = loadUserRules()
		console.log(`rules:  ${ruleSet.dirs.join(', ')} (${rulesFor(ruleSet.rules, project.codeHost).length} of ${ruleSet.rules.length} apply here${ruleSet.skipped.length ? `, ${ruleSet.skipped.length} skipped` : ''})`)
		console.log('Also enable Settings > Experimental > Orchestration in Orca before starting workers.')
		return checks.every(([, ok]) => ok) ? 0 : 1
	}

	console.error(`unknown command "${command}"\n`)
	console.log(HELP)
	return 1
}

main(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code
	},
	(err: unknown) => {
		console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
		process.exitCode = 1
	}
)

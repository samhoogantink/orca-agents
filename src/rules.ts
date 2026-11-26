import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { knownGitHubHosts, parseRemote, type CodeHost } from './project.ts'

/**
 * User rules from `~/.orca-agents/rules/**\/*.md` and the folders listed in rules.json. Each file looks like a skill: YAML-style
 * frontmatter with a required `name`, optional `repository`, `description`, `roles` (default all)
 * and `active` (default true), then Markdown that workers receive in their spec.
 */

export type Rule = {
	name: string
	/** Only applies in this repository (`owner/repo`, `org/project/repo` or a remote URL). */
	repository?: string
	description?: string
	/** Only applies to workers in these roles; undefined means every role. */
	roles?: string[]
	active: boolean
	body: string
	/** Absolute path of the rule file. */
	path: string
}

export type SkippedRule = { path: string; reason: string }

/** `dirs`: the home rules folder first, then the folders from rules.json. */
export type RuleSet = { dirs: string[]; rules: Rule[]; skipped: SkippedRule[] }

export type RuleVerdict = 'applies' | 'inactive' | 'other repository' | 'other role'

/** Splits `---` frontmatter from the body. Returns null when the file has no frontmatter. */
export function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } | null {
	const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
	const m = /^---[ \t]*\n([\s\S]*?)\n?---[ \t]*(?:\n|$)/.exec(src)
	if (!m) return null
	const fields: Record<string, string> = {}
	const lines = m[1]!.split('\n')
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!
		if (!line.trim() || line.trimStart().startsWith('#')) continue
		const kv = /^([A-Za-z_][\w-]*)[ \t]*:(.*)$/.exec(line)
		if (!kv) continue
		const key = kv[1]!
		let value = kv[2]!.trim()
		const block = /^([>|])([+-]?)$/.exec(value)
		if (!value && i + 1 < lines.length && /^\s*-\s/.test(lines[i + 1]!)) {
			// A block list (`roles:` then `  - architect` lines), kept as a comma-separated value.
			const items: string[] = []
			while (i + 1 < lines.length && /^\s*-\s/.test(lines[i + 1]!)) items.push(lines[++i]!.replace(/^\s*-\s*/, '').trim())
			value = items.join(', ')
		} else if (block) {
			// A block scalar (`description: >-`): the indented lines that follow.
			const parts: string[] = []
			while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || !lines[i + 1]!.trim())) parts.push(lines[++i]!.trim())
			while (parts.length && !parts.at(-1)) parts.pop()
			value = block[1] === '>' ? parts.join(' ').replace(/ {2,}/g, ' ') : parts.join('\n')
		} else if (/^(["']).*\1$/.test(value) && value.length >= 2) {
			value = value.slice(1, -1)
		} else {
			value = value.replace(/\s+#.*$/, '')
		}
		fields[key] = value
	}
	return { fields, body: src.slice(m[0].length) }
}

function parseActive(value: string | undefined): boolean | null {
	if (value === undefined || value === '') return true
	const v = value.toLowerCase()
	if (['true', 'yes', 'on'].includes(v)) return true
	if (['false', 'no', 'off'].includes(v)) return false
	return null
}

/** `architect, reviewer`, `[architect, reviewer]` or a block list; empty means every role. */
export function parseRoles(value: string | undefined): string[] | undefined {
	const roles = (value ?? '')
		.trim()
		.replace(/^\[|\]$/g, '')
		.split(',')
		.map((r) => r.trim().replace(/^(["'])(.*)\1$/, '$2').trim().toLowerCase())
		.filter(Boolean)
	return roles.length ? [...new Set(roles)] : undefined
}

/** Reads one rule file; a string is the reason it was skipped. */
export function parseRule(text: string, path: string): Rule | string {
	const parsed = parseFrontmatter(text)
	if (!parsed) return 'no frontmatter with a name'
	const { fields, body } = parsed
	const name = fields.name?.trim()
	if (!name) return 'no name in the frontmatter'
	const active = parseActive(fields.active?.trim())
	if (active === null) return `active must be true or false, not "${fields.active}"`
	return {
		name,
		repository: fields.repository?.trim() || undefined,
		description: fields.description?.trim() || undefined,
		roles: parseRoles(fields.roles),
		active,
		body: body.trim(),
		path
	}
}

/**
 * Loads every `.md` file under `dir` (subfolders included), then under each of `extraDirs` (from
 * rules.json), sorted by path within each folder. A missing `dir` means no rules from it; a missing
 * extra folder is reported as skipped. A name already loaded from an earlier folder wins.
 */
export function loadRules(dir: string, extraDirs: string[] = []): RuleSet {
	const dirs = [...new Set([dir, ...extraDirs])]
	const rules: Rule[] = []
	const skipped: SkippedRule[] = []
	const seen = new Map<string, { path: string; folder: string }>()
	for (const folder of dirs) {
		let files: string[]
		try {
			files = readdirSync(folder, { recursive: true, encoding: 'utf8' })
		} catch (err) {
			if (folder !== dir) skipped.push({ path: folder, reason: `cannot read the rules folder: ${err instanceof Error ? err.message : String(err)}` })
			continue
		}
		for (const rel of files.filter((f) => f.toLowerCase().endsWith('.md')).sort()) {
			const path = join(folder, rel)
			let text: string
			try {
				if (!statSync(path).isFile()) continue
				text = readFileSync(path, 'utf8')
			} catch (err) {
				skipped.push({ path, reason: `cannot read: ${err instanceof Error ? err.message : String(err)}` })
				continue
			}
			const rule = parseRule(text, path)
			if (typeof rule === 'string') {
				skipped.push({ path, reason: rule })
				continue
			}
			const first = seen.get(rule.name.toLowerCase())
			if (first) {
				const where = first.folder === folder ? relative(folder, first.path) : first.path
				skipped.push({ path, reason: `duplicate name "${rule.name}" (already loaded from ${where})` })
				continue
			}
			seen.set(rule.name.toLowerCase(), { path, folder })
			rules.push(rule)
		}
	}
	return { dirs, rules, skipped }
}

function hostIds(host: CodeHost): string[] {
	// The host-qualified id first: a remote URL in a rule names one host, owner/repo any of them.
	if (host.kind === 'github') return [`${host.host}/${host.owner}/${host.repo}`, `${host.owner}/${host.repo}`]
	if (host.kind === 'azure-devops') return [`${host.organization}/${host.project}/${host.repo}`, `${host.project}/${host.repo}`]
	return []
}

/**
 * Whether a rule's `repository` names the project's code host repository. Accepts `owner/repo`
 * (GitHub on any host), `host/owner/repo` (GitHub or GitHub Enterprise on that host),
 * `org/project/repo` or `project/repo` (Azure DevOps), or a remote URL. Case-insensitive.
 */
export function repositoryMatches(repository: string, host: CodeHost): boolean {
	const ids = hostIds(host).map((s) => s.toLowerCase())
	if (!ids.length) return false
	const want = repository.trim()
	const parsed = parseRemote(want, host.kind === 'github' ? [...knownGitHubHosts(), host.host] : knownGitHubHosts())
	const wanted = parsed.kind === 'github' || parsed.kind === 'azure-devops' ? hostIds(parsed).slice(0, 1) : [want.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '')]
	return wanted.some((w) => ids.includes(w.toLowerCase()))
}

/** Without a role, only `active` and `repository` are checked (for listings across all roles). */
export function ruleVerdict(rule: Rule, host: CodeHost, role?: string): RuleVerdict {
	if (!rule.active) return 'inactive'
	if (rule.repository && !repositoryMatches(rule.repository, host)) return 'other repository'
	if (role && rule.roles && !rule.roles.includes(role.toLowerCase())) return 'other role'
	return 'applies'
}

/** The active rules for this project and role: global ones, plus those whose repository and roles match. */
export function rulesFor(rules: Rule[], host: CodeHost, role?: string): Rule[] {
	return rules.filter((r) => ruleVerdict(r, host, role) === 'applies')
}

/** The "User rules" section of a worker spec, or undefined when no rule applies. */
export function rulesSection(rules: Rule[]): string | undefined {
	if (!rules.length) return undefined
	const parts = [
		'## User rules',
		"Rules the user set for their own work. Follow them alongside the project's instructions; if one conflicts with them, ask the coordinator."
	]
	for (const r of rules) {
		parts.push([`### ${r.name}`, r.description ? `_${r.description}_` : '', r.body].filter(Boolean).join('\n\n'))
	}
	return parts.join('\n\n')
}

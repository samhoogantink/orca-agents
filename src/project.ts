import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Works out where a project keeps its work items and code, from the project itself: the git
 * remote, its instruction files (AGENTS.md, agents.toml, CLAUDE.md, README.md, ...) and recent
 * git history. Nothing is configured in orca-agents; the project's own files decide.
 */

export type TrackerKind = 'jira' | 'azure-boards' | 'github'
export const TRACKERS: TrackerKind[] = ['jira', 'azure-boards', 'github']
export const TRACKER_NAMES: Record<TrackerKind, string> = { jira: 'Jira', 'azure-boards': 'Azure Boards', github: 'GitHub Issues' }

export type CodeHost =
	/** `host` is github.com, or a GitHub Enterprise host (Server, or Cloud with data residency on *.ghe.com). */
	| { kind: 'github'; remote: string; host: string; owner: string; repo: string }
	| { kind: 'azure-devops'; remote: string; organization: string; project: string; repo: string }
	| { kind: 'other'; remote: string }
	| { kind: 'none' }

export type Evidence = { tracker: TrackerKind; weight: number; source: string; detail: string }
export type DocsSource = { kind: 'confluence' | 'github-wiki' | 'azure-wiki'; url: string }
export type Confidence = 'high' | 'medium' | 'low' | 'none'

export type ProjectInfo = {
	root: string
	codeHost: CodeHost
	tracker: TrackerKind | null
	confidence: Confidence
	scores: Record<TrackerKind, number>
	/** Strongest evidence first; one entry per tracker and source. */
	evidence: Evidence[]
	jira: { sites: string[]; keys: string[] }
	azure?: { organization: string; project: string }
	githubRepo?: string
	/** The GitHub Enterprise host `githubRepo` and bare #12 references live on; absent for github.com. */
	githubHost?: string
	docs: DocsSource[]
	/** Instruction files found, relative to the root, most authoritative first. */
	instructionFiles: string[]
}

/** Runs git in the project; returns stdout, or null when git fails. */
export type GitRunner = (args: string[]) => string | null

export const realGit = (root: string): GitRunner => (args) => {
	// git is a real executable on every platform, so no shell (and no cmd.exe % expansion).
	const res = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 15_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
	return res.status === 0 ? res.stdout : null
}

/** The git top level of `cwd`, or `cwd` itself outside a repository. */
export function findProjectRoot(cwd: string, git: GitRunner = realGit(cwd)): string {
	const top = git(['rev-parse', '--show-toplevel'])?.trim()
	return top ? resolve(top) : resolve(cwd)
}

export const GITHUB_COM = 'github.com'

function normalizeHost(value: string): string {
	return value.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^[^@/]*@/, '').replace(/[/:].*$/, '')
}

/** github.com under its other names (www, ssh over port 443); every other host as is. */
function canonicalHost(host: string): string {
	const h = normalizeHost(host)
	return h === 'www.github.com' || h === 'ssh.github.com' ? GITHUB_COM : h
}

/** Host names from gh's hosts.yml, as `gh auth login --hostname <host>` writes them. */
function ghConfigHosts(env: NodeJS.ProcessEnv): string[] {
	const xdg = env.XDG_CONFIG_HOME?.trim()
	const dir =
		env.GH_CONFIG_DIR?.trim() ||
		(xdg ? join(xdg, 'gh') : process.platform === 'win32' && env.AppData ? join(env.AppData, 'GitHub CLI') : join(homedir(), '.config', 'gh'))
	let text: string
	try {
		text = readFileSync(join(dir, 'hosts.yml'), 'utf8')
	} catch {
		return []
	}
	return [...text.matchAll(/^(?:"([^"]+)"|'([^']+)'|([^\s#:'"][^:]*?)):\s*$/gm)].map((m) => (m[1] ?? m[2] ?? m[3])!)
}

let defaultHosts: string[] | undefined

/**
 * GitHub Enterprise hosts this machine knows about: `ORCA_AGENTS_GITHUB_HOSTS` (comma or space
 * separated), `GH_HOST`, and the hosts gh is signed in to. Read once per process unless `env` is given.
 */
export function knownGitHubHosts(env?: NodeJS.ProcessEnv): string[] {
	if (!env && defaultHosts) return defaultHosts
	const e = env ?? process.env
	const hosts = [...(e.ORCA_AGENTS_GITHUB_HOSTS ?? '').split(/[\s,]+/), e.GH_HOST ?? '', ...ghConfigHosts(e)]
	const result = [...new Set(hosts.map(canonicalHost).filter((h) => h && h !== GITHUB_COM))]
	if (!env) defaultHosts = result
	return result
}

/**
 * Whether `host` serves GitHub: github.com, GitHub Enterprise Cloud with data residency
 * (`*.ghe.com`), a GitHub Enterprise Server named `github.<company>.<tld>`, or a `known` host.
 */
export function isGitHubHost(host: string, known: readonly string[] = knownGitHubHosts()): boolean {
	const h = canonicalHost(host)
	if (!h) return false
	return (
		h === GITHUB_COM ||
		h.endsWith('.ghe.com') ||
		/^github\.[a-z0-9-]+\.[a-z0-9.-]+$/.test(h) ||
		known.some((k) => canonicalHost(k) === h)
	)
}

/** `owner/repo` on github.com, `host/owner/repo` elsewhere: the form gh's `--repo` takes. */
export function githubRepoRef(host: string | undefined, repo: string): string {
	return host && host !== GITHUB_COM ? `${host}/${repo}` : repo
}

/** Splits https://, ssh://, scp-style (git@host:path) and scheme-less host/path remotes. */
function splitRemote(remote: string): { host: string; path: string } | null {
	const m =
		/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:\s]+)(?::\d*)?\/(.*)$/i.exec(remote) ??
		/^(?:[^@/\s]+@)?([^/:\s]+\.[^/:\s]+):(?!\/)(.*)$/.exec(remote) ??
		/^([^/:@\s]+\.[^/:@\s]+)\/(.*)$/.exec(remote)
	return m ? { host: m[1]!, path: m[2]! } : null
}

/** One line for people: "GitHub (owner/repo)", "GitHub Enterprise (host/owner/repo)", ... */
export function codeHostLabel(host: CodeHost): string {
	switch (host.kind) {
		case 'github':
			return host.host === GITHUB_COM ? `GitHub (${host.owner}/${host.repo})` : `GitHub Enterprise (${host.host}/${host.owner}/${host.repo})`
		case 'azure-devops':
			return `Azure DevOps (${host.organization}/${host.project}/${host.repo})`
		case 'other':
			return host.remote
		case 'none':
			return 'no git remote'
	}
}

/** `githubHosts` are extra GitHub Enterprise hosts (see knownGitHubHosts and isGitHubHost). */
export function parseRemote(url: string, githubHosts: readonly string[] = knownGitHubHosts()): CodeHost {
	const remote = url.trim()
	const split = splitRemote(remote)
	if (split && isGitHubHost(split.host, githubHosts)) {
		const gh = /^\/?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/*$/i.exec(split.path)
		if (gh) return { kind: 'github', remote, host: canonicalHost(split.host), owner: gh[1]!, repo: gh[2]! }
	}
	const azure =
		/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+?)\/?$/i.exec(remote) ??
		/ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+?)\/?$/i.exec(remote)
	if (azure) {
		return { kind: 'azure-devops', remote, organization: decodeURIComponent(azure[1]!), project: decodeURIComponent(azure[2]!), repo: decodeURIComponent(azure[3]!) }
	}
	const vs = /([\w-]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/]+?)\/?$/i.exec(remote) ??
		/vs-ssh\.visualstudio\.com:v3\/([^/]+)\/([^/]+)\/([^/]+?)\/?$/i.exec(remote)
	if (vs) {
		return { kind: 'azure-devops', remote, organization: decodeURIComponent(vs[1]!), project: decodeURIComponent(vs[2]!), repo: decodeURIComponent(vs[3]!) }
	}
	return { kind: 'other', remote }
}

/** Instruction files, most authoritative first, with the weight one of their links or mentions carries. */
const INSTRUCTION_FILES: [string, number][] = [
	['agents.toml', 6],
	['AGENTS.md', 6],
	['CLAUDE.md', 6],
	['.github/copilot-instructions.md', 6],
	['README.md', 4],
	['CONTRIBUTING.md', 4],
	['.github/pull_request_template.md', 4],
	['.github/PULL_REQUEST_TEMPLATE.md', 4],
	['.azuredevops/pull_request_template.md', 4]
]

/** Finds `rel` under `root` ignoring case, so readme.md and README.md both count on Linux. */
function findFile(root: string, rel: string): string | null {
	let dir = root
	const parts = rel.split('/')
	for (const [i, part] of parts.entries()) {
		let entries: string[]
		try {
			entries = readdirSync(dir)
		} catch {
			return null
		}
		const hit = entries.find((e) => e.toLowerCase() === part.toLowerCase())
		if (!hit) return null
		dir = join(dir, hit)
		if (i < parts.length - 1 && !statSync(dir).isDirectory()) return null
	}
	return statSync(dir).isFile() ? dir : null
}

/** Uppercase prefixes that look like Jira keys but are versions or standards (UTF-8, SHA-256, ...). */
const NOT_JIRA = new Set([
	'UTF', 'SHA', 'ISO', 'RFC', 'CVE', 'CWE', 'GHSA', 'HTTP', 'TLS', 'SSL', 'IPV', 'ES', 'ECMA', 'PEP', 'JSR',
	'AES', 'MD', 'RSA', 'BSD', 'GPL', 'LGPL', 'AGPL', 'LTS', 'WCAG', 'ISBN', 'COVID', 'PR', 'WIP', 'RC', 'BETA',
	'ALPHA', 'NET', 'HTML', 'CSS', 'ARM', 'X86', 'WIN', 'OS', 'API', 'V', 'TODO', 'FIXME', 'AB', 'GH', 'CI', 'CD'
])
const JIRA_KEY = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,7})\b/g

type Scan = {
	evidence: Map<string, Evidence>
	jiraSites: Set<string>
	jiraKeyPrefixes: Map<string, number>
	azure?: { organization: string; project: string }
	githubRepo?: string
	githubHost?: string
	githubHosts: readonly string[]
	docs: Map<string, DocsSource>
}

function addEvidence(scan: Scan, e: Evidence): void {
	const key = `${e.tracker}\u0000${e.source}`
	const prev = scan.evidence.get(key)
	if (!prev || prev.weight < e.weight) scan.evidence.set(key, e)
}

/** Explicit `tracker = "jira"` style settings, as agents.toml or front matter might carry. */
const EXPLICIT = /^\s*(?:tracker|issue[_-]?tracker|issues|work[_-]?items)\s*[=:]\s*["']?(jira|azure[-_ ]?boards|azure[-_ ]?devops|azure|ado|github(?:[-_ ]?issues)?)["']?\s*(?:#.*)?$/im

function explicitKind(value: string): TrackerKind {
	const v = value.toLowerCase()
	if (v === 'jira') return 'jira'
	return v.startsWith('github') ? 'github' : 'azure-boards'
}

function scanText(text: string, source: string, weight: number, scan: Scan): void {
	const explicit = EXPLICIT.exec(text)
	if (explicit) addEvidence(scan, { tracker: explicitKind(explicit[1]!), weight: 100, source, detail: `sets ${explicit[0].trim()}` })

	for (const m of text.matchAll(/https?:\/\/([a-z0-9-]+)\.atlassian\.net\/([^\s)>\]"'`]*)/gi)) {
		const site = `${m[1]!.toLowerCase()}.atlassian.net`
		const path = m[2] ?? ''
		if (/^wiki\b/i.test(path)) {
			scan.docs.set(`confluence:${site}`, { kind: 'confluence', url: `https://${site}/wiki` })
			continue
		}
		scan.jiraSites.add(site)
		const key = /browse\/([A-Z][A-Z0-9]{1,9})-\d+/.exec(path)
		if (key) scan.jiraKeyPrefixes.set(key[1]!, (scan.jiraKeyPrefixes.get(key[1]!) ?? 0) + 1)
		addEvidence(scan, { tracker: 'jira', weight, source, detail: `links ${site}` })
	}
	for (const m of text.matchAll(/https?:\/\/(jira\.[a-z0-9.-]+)/gi)) {
		addEvidence(scan, { tracker: 'jira', weight, source, detail: `links ${m[1]!.toLowerCase()}` })
	}
	for (const m of text.matchAll(/https?:\/\/(confluence\.[a-z0-9.-]+)/gi)) {
		scan.docs.set(`confluence:${m[1]}`, { kind: 'confluence', url: `https://${m[1]!.toLowerCase()}` })
	}
	if (/\bjira\b/i.test(text)) addEvidence(scan, { tracker: 'jira', weight: weight - 2, source, detail: 'mentions Jira' })

	const azureLinks = [
		...text.matchAll(/https?:\/\/dev\.azure\.com\/([^/\s)]+)\/([^/\s)]+)\/_(workitems|boards|backlogs|sprints|wiki)\b/gi),
		...text.matchAll(/https?:\/\/([\w-]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/\s)]+)\/_(workitems|boards|backlogs|sprints|wiki)\b/gi)
	]
	for (const m of azureLinks) {
		const organization = decodeURIComponent(m[1]!)
		const project = decodeURIComponent(m[2]!)
		if (m[3]!.toLowerCase() === 'wiki') {
			scan.docs.set(`azure-wiki:${organization}/${project}`, { kind: 'azure-wiki', url: `https://dev.azure.com/${organization}/${encodeURIComponent(project)}/_wiki` })
			continue
		}
		scan.azure ??= { organization, project }
		addEvidence(scan, { tracker: 'azure-boards', weight, source, detail: `links Azure Boards (${organization}/${project})` })
	}
	if (/\bAB#\d+/.test(text)) addEvidence(scan, { tracker: 'azure-boards', weight, source, detail: 'uses AB#<id> work item links' })
	if (/\bazure boards\b/i.test(text)) addEvidence(scan, { tracker: 'azure-boards', weight: weight - 2, source, detail: 'mentions Azure Boards' })

	for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+)\/([\w.-]+)\/([\w.-]+)\/(issues|wiki)\b/gi)) {
		if (!isGitHubHost(m[1]!, scan.githubHosts)) continue
		const host = canonicalHost(m[1]!)
		const repo = `${m[2]}/${m[3]}`
		if (m[4]!.toLowerCase() === 'wiki') {
			scan.docs.set(`github-wiki:${host}/${repo}`, { kind: 'github-wiki', url: `https://${host}/${repo}/wiki` })
			continue
		}
		if (!scan.githubRepo) {
			scan.githubRepo = repo
			scan.githubHost = host
		}
		addEvidence(scan, { tracker: 'github', weight, source, detail: `links ${githubRepoRef(host, repo)} issues` })
	}
	if (/\bgithub issues?\b/i.test(text)) addEvidence(scan, { tracker: 'github', weight: weight - 2, source, detail: 'mentions GitHub issues' })
}

function scanHistory(git: GitRunner, scan: Scan): void {
	const log = git(['log', '-n', '200', '--no-merges', '--format=%s%n%b%x00'])
	const branches = git(['for-each-ref', '--format=%(refname:short)', '--count=300', 'refs/heads', 'refs/remotes'])
	const jira = new Map<string, number>()
	let ab = 0
	let closes = 0
	const countKeys = (text: string) => {
		const seen = new Set<string>()
		for (const m of text.matchAll(JIRA_KEY)) if (!NOT_JIRA.has(m[1]!)) seen.add(m[1]!)
		for (const prefix of seen) jira.set(prefix, (jira.get(prefix) ?? 0) + 1)
	}
	for (const commit of (log ?? '').split('\0')) {
		if (!commit.trim()) continue
		countKeys(commit)
		if (/\bAB#\d+/.test(commit)) ab++
		// "Fixes #12" links an issue; a bare "(#12)" suffix is usually the squash-merged PR.
		if (/\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+(?:[\w.-]+\/[\w.-]+)?#\d+/i.test(commit)) closes++
	}
	// Only keys written in uppercase count: lowercased, "node-22" from a Renovate branch would pass.
	const names = new Set(
		(branches ?? '').split(/\r?\n/).map((b) => b.trim().replace(/^origin\//, '')).filter((b) => b && !/^(dependabot|renovate)\//i.test(b))
	)
	for (const branch of names) countKeys(branch.replace(/_/g, '-'))

	const [prefix, count] = [...jira.entries()].sort((a, b) => b[1] - a[1])[0] ?? []
	if (prefix && count) {
		scan.jiraKeyPrefixes.set(prefix, (scan.jiraKeyPrefixes.get(prefix) ?? 0) + count)
		if (count >= 3) {
			addEvidence(scan, { tracker: 'jira', weight: count >= 10 ? 4 : 3, source: 'git history', detail: `${count} commits or branches use ${prefix}-<n> keys` })
		}
	}
	if (ab) addEvidence(scan, { tracker: 'azure-boards', weight: ab >= 3 ? 4 : 3, source: 'git history', detail: `${ab} commits link AB#<id>` })
	if (closes) addEvidence(scan, { tracker: 'github', weight: closes >= 2 ? 3 : 2, source: 'git history', detail: `${closes} commits close #<n> issues` })
}

function confidenceOf(scores: Record<TrackerKind, number>): { tracker: TrackerKind | null; confidence: Confidence } {
	const ranked = TRACKERS.map((t) => [t, scores[t]] as const).sort((a, b) => b[1] - a[1])
	const [top, second] = ranked
	if (!top || top[1] === 0) return { tracker: null, confidence: 'none' }
	if (second && second[1] === top[1]) return { tracker: null, confidence: 'low' }
	const runnerUp = second?.[1] ?? 0
	if (top[1] >= 6 && top[1] >= 2 * runnerUp) return { tracker: top[0], confidence: 'high' }
	if (top[1] >= 3) return { tracker: top[0], confidence: 'medium' }
	return { tracker: top[0], confidence: 'low' }
}

/** `githubHosts` are extra GitHub Enterprise hosts; by default those from knownGitHubHosts(). */
export function detectProject(cwd: string, git?: GitRunner, githubHosts: readonly string[] = knownGitHubHosts()): ProjectInfo {
	const root = findProjectRoot(cwd, git ?? realGit(cwd))
	const run = git ?? realGit(root)

	const remotes = (run(['remote']) ?? '').split(/\r?\n/).map((r) => r.trim()).filter(Boolean)
	const remoteName = remotes.includes('origin') ? 'origin' : remotes[0]
	const remoteUrl = remoteName ? run(['remote', 'get-url', remoteName])?.trim() : undefined
	const codeHost: CodeHost = remoteUrl ? parseRemote(remoteUrl, githubHosts) : { kind: 'none' }
	// Links to the remote's own GitHub host count, whatever that host is called.
	const hosts = codeHost.kind === 'github' ? [...githubHosts, codeHost.host] : githubHosts
	const scan: Scan = { evidence: new Map(), jiraSites: new Set(), jiraKeyPrefixes: new Map(), docs: new Map(), githubHosts: hosts }

	const instructionFiles: string[] = []
	const seen = new Set<string>()
	for (const [rel, weight] of INSTRUCTION_FILES) {
		const file = findFile(root, rel)
		if (!file || seen.has(file.toLowerCase())) continue
		seen.add(file.toLowerCase())
		const shown = file.slice(root.length + 1).replace(/\\/g, '/')
		instructionFiles.push(shown)
		let text: string
		try {
			text = readFileSync(file, 'utf8').slice(0, 512 * 1024)
		} catch {
			continue
		}
		scanText(text, shown, weight, scan)
	}
	if (existsSync(join(root, '.github', 'ISSUE_TEMPLATE'))) {
		addEvidence(scan, { tracker: 'github', weight: 2, source: '.github/ISSUE_TEMPLATE', detail: 'has GitHub issue templates' })
	}
	scanHistory(run, scan)

	if (codeHost.kind === 'github') {
		addEvidence(scan, { tracker: 'github', weight: 1, source: 'git remote', detail: `code is on ${codeHostLabel(codeHost)}` })
	} else if (codeHost.kind === 'azure-devops') {
		addEvidence(scan, { tracker: 'azure-boards', weight: 1, source: 'git remote', detail: `code is on Azure DevOps (${codeHost.organization}/${codeHost.project})` })
	}

	const evidence = [...scan.evidence.values()].filter((e) => e.weight > 0).sort((a, b) => b.weight - a.weight)
	const scores = Object.fromEntries(TRACKERS.map((t) => [t, 0])) as Record<TrackerKind, number>
	for (const e of evidence) scores[e.tracker] += e.weight
	const azure = scan.azure ?? (codeHost.kind === 'azure-devops' ? { organization: codeHost.organization, project: codeHost.project } : undefined)
	// A bare #12 means this repository, as on GitHub; a fork's README often links upstream issues.
	const githubRepo = codeHost.kind === 'github' ? `${codeHost.owner}/${codeHost.repo}` : scan.githubRepo
	const githubHost = codeHost.kind === 'github' ? codeHost.host : scan.githubHost
	return {
		root,
		codeHost,
		...confidenceOf(scores),
		scores,
		evidence,
		jira: {
			sites: [...scan.jiraSites],
			keys: [...scan.jiraKeyPrefixes.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k)
		},
		azure,
		githubRepo,
		...(githubHost && githubHost !== GITHUB_COM ? { githubHost } : {}),
		docs: [...scan.docs.values()],
		instructionFiles
	}
}

export type WorkItem = {
	tracker: TrackerKind
	/** ECOM-123, 1234 or owner/repo#12. */
	id: string
	/** Safe for worktree names and note folders: ecom-123, ab-1234, gh-12. */
	slug: string
	url?: string
	/** The GitHub Enterprise host of a GitHub item; absent for github.com. */
	host?: string
}

/**
 * Reads a work-item reference the way people write it: a URL, ECOM-123 (Jira), AB#1234 (Azure
 * Boards), owner/repo#12 or #12 (GitHub). A bare number takes the project's detected tracker.
 * GitHub issue URLs may be on github.com or a GitHub Enterprise host (see isGitHubHost); short
 * references are on the project's GitHub host.
 */
export function parseWorkItem(ref: string, project?: ProjectInfo, githubHosts: readonly string[] = knownGitHubHosts()): WorkItem {
	const text = ref.trim()
	let m = /^https?:\/\/([a-z0-9-]+\.atlassian\.net|jira\.[a-z0-9.-]+)\/.*?\b([A-Z][A-Z0-9]{1,9}-\d+)\b/i.exec(text)
	if (m) return { tracker: 'jira', id: m[2]!.toUpperCase(), slug: m[2]!.toLowerCase(), url: text }
	m = /^https?:\/\/(?:dev\.azure\.com\/[^/]+|[\w-]+\.visualstudio\.com)\/.*?_workitems\/edit\/(\d+)/i.exec(text)
	if (m) return { tracker: 'azure-boards', id: m[1]!, slug: `ab-${m[1]}`, url: text }
	m = /^https?:\/\/([a-z0-9.-]+)\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/i.exec(text)
	if (m && isGitHubHost(m[1]!, project?.githubHost ? [...githubHosts, project.githubHost] : githubHosts)) {
		const host = canonicalHost(m[1]!)
		return { tracker: 'github', id: `${m[2]}#${m[3]}`, slug: `gh-${m[3]}`, url: text, ...(host !== GITHUB_COM ? { host } : {}) }
	}
	if (/^https?:\/\//i.test(text)) throw new Error(`not a Jira, Azure Boards or GitHub issue URL: ${text}`)

	m = /^AB#(\d+)$/i.exec(text)
	if (m) return withUrl({ tracker: 'azure-boards', id: m[1]!, slug: `ab-${m[1]}` }, project)
	m = /^([\w.-]+\/[\w.-]+)?#(\d+)$/.exec(text)
	if (m) {
		const repo = m[1] ?? project?.githubRepo
		const host = project?.githubHost
		return withUrl({ tracker: 'github', id: repo ? `${repo}#${m[2]}` : `#${m[2]}`, slug: `gh-${m[2]}`, ...(host ? { host } : {}) }, project)
	}
	m = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d+)$/.exec(text)
	if (m) return withUrl({ tracker: 'jira', id: `${m[1]!.toUpperCase()}-${m[2]}`, slug: text.toLowerCase() }, project)
	m = /^\d+$/.exec(text)
	if (m) {
		const tracker = project?.tracker
		if (tracker === 'jira') throw new Error(`"${text}" is a bare number, but Jira keys need a project prefix such as ${project?.jira.keys[0] ?? 'ABC'}-${text}`)
		if (tracker === 'github') return parseWorkItem(`#${text}`, project)
		if (tracker === 'azure-boards') return withUrl({ tracker, id: text, slug: `ab-${text}` }, project)
		throw new Error(`cannot tell which tracker "${text}" belongs to; pass a URL, AB#${text} or #${text}`)
	}
	throw new Error(`unrecognised work item "${text}"; use a URL, ABC-123 (Jira), AB#123 (Azure Boards) or #123 (GitHub)`)
}

function withUrl(item: WorkItem, project?: ProjectInfo): WorkItem {
	if (item.tracker === 'jira' && project?.jira.sites.length === 1) {
		return { ...item, url: `https://${project.jira.sites[0]}/browse/${item.id}` }
	}
	if (item.tracker === 'azure-boards' && project?.azure) {
		const { organization, project: name } = project.azure
		return { ...item, url: `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(name)}/_workitems/edit/${item.id}` }
	}
	if (item.tracker === 'github' && item.id.includes('/')) {
		const [repo, n] = item.id.split('#')
		return { ...item, url: `https://${item.host ?? GITHUB_COM}/${repo}/issues/${n}` }
	}
	return item
}

const HOW_TO_READ: Record<TrackerKind, (p: ProjectInfo, item?: WorkItem) => string> = {
	jira: (p) =>
		`Read it with the Atlassian MCP (Jira tools)${p.jira.sites.length ? ` on ${p.jira.sites.join(', ')}` : ''}.`,
	'azure-boards': (p, item) =>
		`Read it with the Azure DevOps MCP${p.azure ? ` (organization ${p.azure.organization}, project ${p.azure.project})` : ''}, ` +
		`or \`az boards work-item show --id ${item?.id ?? '<id>'}${p.azure ? ` --org https://dev.azure.com/${p.azure.organization}` : ''}\`.`,
	github: (p, item) => {
		const repo = item?.id.includes('/') ? item.id.split('#')[0] : p.githubRepo
		const host = item ? item.host : p.githubHost
		const n = item ? item.id.split('#')[1] : '<n>'
		const mcp = host ? `the GitHub MCP (set up for ${host})` : 'the GitHub MCP'
		return `Read it with ${mcp}, or \`gh issue view ${n}${repo ? ` --repo ${githubRepoRef(host, repo)}` : ''} --comments\`.`
	}
}

function codeHostLine(host: CodeHost): string {
	switch (host.kind) {
		case 'github':
			return host.host === GITHUB_COM
				? `GitHub (${host.owner}/${host.repo}). Read linked pull requests and commits with the GitHub MCP or \`gh pr view\`.`
				: `${codeHostLabel(host)}. Read linked pull requests and commits with the GitHub MCP (set up for ${host.host}) or \`gh pr view --repo ${host.host}/${host.owner}/${host.repo}\`.`
		case 'azure-devops':
			return `Azure DevOps Repos (${host.organization}/${host.project}/${host.repo}). Read linked pull requests with the Azure DevOps MCP or \`az repos pr show\`.`
		case 'other':
			return `${host.remote} (not GitHub or Azure DevOps). Use local git history for linked changes.`
		case 'none':
			return 'no git remote. Use local git history for linked changes.'
	}
}

const docsName = { confluence: 'Confluence (Atlassian MCP)', 'github-wiki': 'GitHub wiki', 'azure-wiki': 'Azure DevOps wiki (Azure DevOps MCP)' }

/** The "Project context" section every worker spec carries. */
export function projectContext(p: ProjectInfo, item?: WorkItem): string {
	const tracker = item?.tracker ?? p.tracker
	const lines = [
		'## Project context',
		'',
		`Detected by orca-agents from the git remote and project files in \`${p.root}\`. The project's own instructions win where they differ.`,
		''
	]
	if (item) lines.push(`- Work item: **${item.id}** (${TRACKER_NAMES[item.tracker]})${item.url ? ` ${item.url}` : ''}`)
	if (tracker) {
		const why = item ? 'named in the request' : `${p.confidence} confidence: ${p.evidence.filter((e) => e.tracker === tracker).slice(0, 3).map((e) => `${e.source} ${e.detail}`).join('; ')}`
		lines.push(`- Tracker: ${TRACKER_NAMES[tracker]} (${why}). ${HOW_TO_READ[tracker](p, item)}`)
	} else {
		lines.push('- Tracker: not detected. Ask the coordinator where the requirements live; do not guess.')
	}
	lines.push(`- Code host: ${codeHostLine(p.codeHost)}`)
	if (p.docs.length) lines.push(`- Documents: ${p.docs.map((d) => `${docsName[d.kind]} ${d.url}`).join(', ')}`)
	lines.push(
		p.instructionFiles.length
			? `- Project instructions: ${p.instructionFiles.map((f) => `\`${f}\``).join(', ')}. Read and follow them; they set scope and extra rules.`
			: '- Project instructions: none found. Ask the coordinator about scope when it is unclear.'
	)
	return lines.join('\n')
}

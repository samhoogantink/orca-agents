import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { startRole, type Deps } from '../src/pipeline.ts'
import { REPO_ROOT } from '../src/paths.ts'
import { detectProject, isGitHubHost, knownGitHubHosts, parseRemote, parseWorkItem, projectContext, type GitRunner, type ProjectInfo } from '../src/project.ts'
import { composeSpec } from '../src/spec.ts'
import { NOW, fakeRunner, freshState, testConfig } from './helpers.ts'

type Repo = { files?: Record<string, string>; dirs?: string[]; commits?: string[]; branches?: string[]; remote?: string; githubHosts?: string[] }

/** A project folder plus a fake git that answers the few commands detection runs. */
function repo(r: Repo): { root: string; git: GitRunner } {
	const root = mkdtempSync(join(tmpdir(), 'oa-project-'))
	for (const [rel, text] of Object.entries(r.files ?? {})) {
		mkdirSync(dirname(join(root, rel)), { recursive: true })
		writeFileSync(join(root, rel), text)
	}
	for (const dir of r.dirs ?? []) mkdirSync(join(root, dir), { recursive: true })
	const git: GitRunner = (args) => {
		if (args[0] === 'rev-parse') return `${root}\n`
		if (args[0] === 'log') return (r.commits ?? []).map((c) => `${c}\n\0`).join('')
		if (args[0] === 'for-each-ref') return (r.branches ?? []).join('\n')
		if (args[0] === 'remote' && args.length === 1) return r.remote ? 'origin\n' : ''
		if (args[0] === 'remote' && args[1] === 'get-url') return r.remote ? `${r.remote}\n` : null
		return null
	}
	return { root, git }
}

const detect = (r: Repo): ProjectInfo => {
	const { root, git } = repo(r)
	return detectProject(root, git, r.githubHosts ?? [])
}

test('project: parses GitHub, Azure DevOps and other remotes', () => {
	assert.deepEqual(parseRemote('https://github.com/contoso/shop.git'), { kind: 'github', remote: 'https://github.com/contoso/shop.git', host: 'github.com', owner: 'contoso', repo: 'shop' })
	assert.equal(parseRemote('git@github.com:contoso/shop.git').kind, 'github')
	const ssh443 = parseRemote('ssh://git@ssh.github.com:443/contoso/shop.git')
	assert.equal(ssh443.kind === 'github' && `${ssh443.host}/${ssh443.owner}/${ssh443.repo}`, 'github.com/contoso/shop')
	assert.deepEqual(parseRemote('https://contoso@dev.azure.com/contoso/Web%20Shop/_git/api'), {
		kind: 'azure-devops', remote: 'https://contoso@dev.azure.com/contoso/Web%20Shop/_git/api', organization: 'contoso', project: 'Web Shop', repo: 'api'
	})
	const ssh = parseRemote('git@ssh.dev.azure.com:v3/contoso/Shop/api')
	assert.equal(ssh.kind === 'azure-devops' && `${ssh.organization}/${ssh.project}/${ssh.repo}`, 'contoso/Shop/api')
	const vs = parseRemote('https://contoso.visualstudio.com/DefaultCollection/Shop/_git/api')
	assert.equal(vs.kind === 'azure-devops' && `${vs.organization}/${vs.project}/${vs.repo}`, 'contoso/Shop/api')
	assert.deepEqual(parseRemote('git@gitlab.com:contoso/shop.git'), { kind: 'other', remote: 'git@gitlab.com:contoso/shop.git' })
})

test('project: parses GitHub Enterprise remotes', () => {
	const id = (url: string, hosts: string[] = []) => {
		const h = parseRemote(url, hosts)
		return h.kind === 'github' ? `${h.host}/${h.owner}/${h.repo}` : h.kind
	}
	// Server named github.<company>.<tld>, and Cloud with data residency, need no configuration.
	assert.equal(id('https://github.contoso.com/shop/api.git'), 'github.contoso.com/shop/api')
	assert.equal(id('git@github.contoso.com:shop/api.git'), 'github.contoso.com/shop/api')
	assert.equal(id('ssh://git@GitHub.Contoso.com:2222/shop/api'), 'github.contoso.com/shop/api')
	assert.equal(id('https://contoso.ghe.com/shop/api'), 'contoso.ghe.com/shop/api')
	assert.equal(id('git@contoso.ghe.com:shop/api.git'), 'contoso.ghe.com/shop/api')
	// Any other name only once it is known.
	assert.equal(id('https://code.contoso.com/shop/api.git'), 'other')
	assert.equal(id('https://code.contoso.com/shop/api.git', ['code.contoso.com']), 'code.contoso.com/shop/api')
	assert.equal(id('https://code.contoso.com/shop/api.git', ['https://CODE.contoso.com/']), 'code.contoso.com/shop/api')
	// Not every host named github is GitHub, and a path that is not owner/repo is not a repository.
	assert.equal(id('https://github.io/shop/api'), 'other')
	assert.equal(id('https://github.contoso.com/shop/api/extra'), 'other')
})

test('project: knows GitHub Enterprise hosts from env and gh hosts.yml', () => {
	const gh = mkdtempSync(join(tmpdir(), 'oa-gh-'))
	writeFileSync(join(gh, 'hosts.yml'), 'github.com:\n    user: me\ncode.contoso.com:\n    git_protocol: https\n    users:\n        me:\n"git.fabrikam.net":\n    user: me\n')
	const hosts = knownGitHubHosts({ ORCA_AGENTS_GITHUB_HOSTS: 'ghe.one.example, https://ghe.two.example/', GH_HOST: 'ghe.three.example', GH_CONFIG_DIR: gh })
	assert.deepEqual(hosts, ['ghe.one.example', 'ghe.two.example', 'ghe.three.example', 'code.contoso.com', 'git.fabrikam.net'])
	assert.deepEqual(knownGitHubHosts({ GH_CONFIG_DIR: join(gh, 'missing') }), [])
	assert.ok(isGitHubHost('git.fabrikam.net', hosts))
	assert.ok(!isGitHubHost('gitlab.fabrikam.net', hosts))
})

test('project: GitHub Enterprise code host, issues and context', () => {
	const p = detect({
		files: {
			'AGENTS.md': 'Issues: https://code.contoso.com/shop/api/issues\nDocs: https://code.contoso.com/shop/api/wiki',
			'README.md': 'Upstream: https://gitlab.com/x/y/issues'
		},
		commits: ['Fixes #12: totals', 'closes #14'],
		remote: 'git@code.contoso.com:shop/api.git',
		githubHosts: ['code.contoso.com']
	})
	assert.deepEqual(p.codeHost, { kind: 'github', remote: 'git@code.contoso.com:shop/api.git', host: 'code.contoso.com', owner: 'shop', repo: 'api' })
	assert.equal(p.tracker, 'github')
	assert.equal(p.confidence, 'high')
	assert.equal(p.githubRepo, 'shop/api')
	assert.equal(p.githubHost, 'code.contoso.com')
	assert.deepEqual(p.docs, [{ kind: 'github-wiki', url: 'https://code.contoso.com/shop/api/wiki' }])
	assert.ok(p.evidence.some((e) => e.detail === 'links code.contoso.com/shop/api issues'))
	assert.ok(p.evidence.some((e) => e.detail === 'code is on GitHub Enterprise (code.contoso.com/shop/api)'))

	assert.deepEqual(parseWorkItem('#12', p), { tracker: 'github', id: 'shop/api#12', slug: 'gh-12', url: 'https://code.contoso.com/shop/api/issues/12', host: 'code.contoso.com' })
	assert.equal(parseWorkItem('other/repo#3', p).url, 'https://code.contoso.com/other/repo/issues/3')
	assert.deepEqual(parseWorkItem('https://code.contoso.com/shop/api/issues/5', p, []), {
		tracker: 'github', id: 'shop/api#5', slug: 'gh-5', url: 'https://code.contoso.com/shop/api/issues/5', host: 'code.contoso.com'
	})
	assert.equal(parseWorkItem('https://github.contoso.com/shop/api/issues/6', undefined, []).host, 'github.contoso.com')
	assert.throws(() => parseWorkItem('https://code.contoso.com/shop/api/issues/5', undefined, []), /not a Jira, Azure Boards or GitHub issue URL/)

	const text = projectContext(p, parseWorkItem('#12', p))
	assert.match(text, /- Work item: \*\*shop\/api#12\*\* \(GitHub Issues\) https:\/\/code\.contoso\.com\/shop\/api\/issues\/12/)
	assert.match(text, /Read it with the GitHub MCP \(set up for code\.contoso\.com\), or `gh issue view 12 --repo code\.contoso\.com\/shop\/api --comments`/)
	assert.match(text, /- Code host: GitHub Enterprise \(code\.contoso\.com\/shop\/api\)\. .*`gh pr view --repo code\.contoso\.com\/shop\/api`/)
	assert.match(text, /- Documents: GitHub wiki https:\/\/code\.contoso\.com\/shop\/api\/wiki/)

	// github.com projects keep the short forms.
	const dotcom = projectContext(detect({ remote: 'https://github.com/contoso/shop.git' }), parseWorkItem('#3', detect({ remote: 'https://github.com/contoso/shop.git' })))
	assert.match(dotcom, /Read it with the GitHub MCP, or `gh issue view 3 --repo contoso\/shop --comments`/)
	assert.match(dotcom, /- Code host: GitHub \(contoso\/shop\)\. Read linked pull requests and commits with the GitHub MCP or `gh pr view`\./)
})

test('project: Jira from AGENTS.md links and commit keys, code on GitHub', () => {
	const p = detect({
		files: {
			'AGENTS.md': 'Work items: https://contoso.atlassian.net/browse/ECOM-1\nDocs: https://contoso.atlassian.net/wiki/spaces/ECOM\nNever create changesets.',
			'README.md': '# Shop'
		},
		commits: ['ECOM-12 add basket', 'ECOM-13 fix totals', 'ECOM-14 refactor', 'chore: bump UTF-8 handling'],
		branches: ['feature/ECOM-15-checkout', 'origin/feature/ECOM-15-checkout'],
		remote: 'git@github.com:contoso/shop.git'
	})
	assert.equal(p.tracker, 'jira')
	assert.equal(p.confidence, 'high')
	assert.deepEqual(p.jira, { sites: ['contoso.atlassian.net'], keys: ['ECOM'] })
	assert.equal(p.codeHost.kind, 'github')
	assert.deepEqual(p.docs, [{ kind: 'confluence', url: 'https://contoso.atlassian.net/wiki' }])
	assert.deepEqual(p.instructionFiles, ['AGENTS.md', 'README.md'])
	assert.ok(p.evidence.some((e) => e.source === 'git history' && e.detail === '4 commits or branches use ECOM-<n> keys'))
})

test('project: Azure Boards from README links and AB# commits on Azure DevOps', () => {
	const p = detect({
		files: { 'readme.md': 'Backlog: https://dev.azure.com/contoso/Shop/_workitems/recentlyupdated' },
		commits: ['Fix totals AB#101', 'Add API AB#102', 'Tidy AB#103'],
		remote: 'https://dev.azure.com/contoso/Shop/_git/api'
	})
	assert.equal(p.tracker, 'azure-boards')
	assert.equal(p.confidence, 'high')
	assert.deepEqual(p.azure, { organization: 'contoso', project: 'Shop' })
	assert.deepEqual(p.instructionFiles, ['readme.md'])
	assert.equal(p.codeHost.kind, 'azure-devops')
})

test('project: GitHub Issues from issue templates and closing keywords', () => {
	const p = detect({
		dirs: ['.github/ISSUE_TEMPLATE'],
		commits: ['Fixes #12: totals', 'feat: basket (#40)', 'closes contoso/shop#14'],
		remote: 'https://github.com/contoso/shop'
	})
	assert.equal(p.tracker, 'github')
	assert.equal(p.confidence, 'high')
	assert.equal(p.githubRepo, 'contoso/shop')
})

test('project: a tracker line in agents.toml wins over other evidence', () => {
	const p = detect({
		files: {
			'agents.toml': '[project]\ntracker = "jira"  # ECOM board\n',
			'README.md': 'Old backlog: https://dev.azure.com/contoso/Shop/_boards'
		},
		commits: ['AB#1 x', 'AB#2 y', 'AB#3 z'],
		remote: 'https://dev.azure.com/contoso/Shop/_git/api'
	})
	assert.equal(p.tracker, 'jira')
	assert.equal(p.evidence[0]?.source, 'agents.toml')
	assert.equal(p.evidence[0]?.weight, 100)
})

test('project: version strings and bot branches are not Jira keys', () => {
	const p = detect({
		commits: ['Use UTF-8 everywhere', 'Switch to SHA-256', 'Target ES-2022', 'Patch CVE-2024-1234', 'Add ISO-8601 dates'],
		branches: ['renovate/node-22.x', 'dependabot/npm_and_yarn/LODASH-4.17.21', 'main'],
		remote: 'https://github.com/contoso/shop.git'
	})
	assert.ok(!p.evidence.some((e) => e.tracker === 'jira'), JSON.stringify(p.evidence))
	assert.equal(p.tracker, 'github')
	assert.equal(p.confidence, 'low')
})

test('project: a mention alone is weak, ties are undecided, no git is none', () => {
	assert.equal(detect({ files: { 'README.md': 'We used Azure Boards once.' } }).confidence, 'low')
	const tie = detect({ files: { 'AGENTS.md': 'Tickets: https://contoso.atlassian.net/browse/A-1 and https://github.com/contoso/shop/issues' } })
	assert.deepEqual([tie.tracker, tie.confidence], [null, 'low'])
	const none = detectProject(mkdtempSync(join(tmpdir(), 'oa-empty-')), () => null)
	assert.deepEqual([none.tracker, none.confidence, none.codeHost.kind, none.instructionFiles], [null, 'none', 'none', []])
})

test('project: parses work item references', () => {
	const jira = detect({ files: { 'AGENTS.md': 'https://contoso.atlassian.net/browse/ECOM-1' } })
	assert.deepEqual(parseWorkItem('ecom-123', jira), { tracker: 'jira', id: 'ECOM-123', slug: 'ecom-123', url: 'https://contoso.atlassian.net/browse/ECOM-123' })
	assert.deepEqual(parseWorkItem('https://contoso.atlassian.net/browse/ECOM-9?focus=1'), {
		tracker: 'jira', id: 'ECOM-9', slug: 'ecom-9', url: 'https://contoso.atlassian.net/browse/ECOM-9?focus=1'
	})
	assert.throws(() => parseWorkItem('123', jira), /need a project prefix such as ECOM-123/)

	const azure = detect({ remote: 'https://dev.azure.com/contoso/Web%20Shop/_git/api' })
	assert.deepEqual(parseWorkItem('AB#77', azure), { tracker: 'azure-boards', id: '77', slug: 'ab-77', url: 'https://dev.azure.com/contoso/Web%20Shop/_workitems/edit/77' })
	assert.equal(parseWorkItem('77', azure).tracker, 'azure-boards')
	assert.equal(parseWorkItem('https://dev.azure.com/contoso/Shop/_workitems/edit/88').id, '88')

	const gh = detect({ remote: 'https://github.com/contoso/shop.git' })
	assert.deepEqual(parseWorkItem('#12', gh), { tracker: 'github', id: 'contoso/shop#12', slug: 'gh-12', url: 'https://github.com/contoso/shop/issues/12' })
	assert.deepEqual(parseWorkItem('12', gh), parseWorkItem('#12', gh))
	assert.equal(parseWorkItem('other/repo#3', gh).url, 'https://github.com/other/repo/issues/3')
	assert.equal(parseWorkItem('https://github.com/contoso/shop/issues/5').id, 'contoso/shop#5')

	assert.throws(() => parseWorkItem('5'), /cannot tell which tracker/)
	assert.throws(() => parseWorkItem('https://example.com/ticket/5'), /not a Jira, Azure Boards or GitHub issue URL/)
	assert.throws(() => parseWorkItem('fix the thing'), /unrecognised work item/)
})

test('project: the context section names tracker, code host, documents and instructions', () => {
	const p = detect({
		files: { 'AGENTS.md': 'https://contoso.atlassian.net/browse/ECOM-1 https://contoso.atlassian.net/wiki/x' },
		remote: 'https://dev.azure.com/contoso/Shop/_git/api'
	})
	const text = projectContext(p, parseWorkItem('ECOM-7', p))
	assert.match(text, /^## Project context/)
	assert.match(text, /- Work item: \*\*ECOM-7\*\* \(Jira\) https:\/\/contoso\.atlassian\.net\/browse\/ECOM-7/)
	assert.match(text, /- Tracker: Jira \(named in the request\)\. Read it with the Atlassian MCP \(Jira tools\) on contoso\.atlassian\.net\./)
	assert.match(text, /- Code host: Azure DevOps Repos \(contoso\/Shop\/api\)/)
	assert.match(text, /- Documents: Confluence \(Atlassian MCP\) https:\/\/contoso\.atlassian\.net\/wiki/)
	assert.match(text, /- Project instructions: `AGENTS\.md`\. Read and follow them/)
	const unknown = projectContext(detectProject(mkdtempSync(join(tmpdir(), 'oa-empty-')), () => null))
	assert.match(unknown, /- Tracker: not detected\. Ask the coordinator/)
	assert.match(unknown, /- Code host: no git remote/)
})

test('spec: project context sits between the inputs and the reporting contract', () => {
	const spec = composeSpec({ role: 'architect', rolePrompt: 'Design.', title: 'ECOM-7', inputs: [{ label: 'Task input', text: 'Go.' }], context: '## Project context\n\n- Tracker: Jira' })
	assert.ok(spec.indexOf('## Task input') < spec.indexOf('## Project context'))
	assert.ok(spec.indexOf('## Project context') < spec.indexOf('## Reporting back'))
	assert.doesNotMatch(spec, /Azure Boards|PBI|changeset/)
})

test('start writes the project context into the task spec', async () => {
	const { runner, calls } = fakeRunner({
		'orchestration task-create': () => ({ ok: true, result: { taskId: 'task_1' } }),
		'orchestration worker-start': () => ({ ok: true, result: { dispatchId: 'd1', taskId: 'task_1', state: 'ready' } })
	})
	const config = testConfig()
	config.configDir = join(REPO_ROOT, 'config')
	const d: Deps = { config, state: freshState(), runner, usage: {}, specDir: mkdtempSync(join(tmpdir(), 'oa-spec-')), now: () => NOW, log: () => {} }
	const res = await startRole(d, { role: 'junior-backend', title: 'ECOM-7', inputs: [{ label: 'Task input', text: 'x' }], context: '## Project context\n\n- Tracker: Jira' })
	assert.ok(res.ok)
	const specFile = calls[0]![calls[0]!.indexOf('--spec-file') + 1]!
	assert.match(readFileSync(specFile, 'utf8'), /## Project context\n\n- Tracker: Jira/)
})

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { parseRemote } from '../src/project.ts'
import { loadRules, parseFrontmatter, parseRule, repositoryMatches, rulesFor, ruleVerdict } from '../src/rules.ts'
import { composeSpec } from '../src/spec.ts'

function rulesDir(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), 'oa-rules-'))
	for (const [rel, text] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, rel)), { recursive: true })
		writeFileSync(join(dir, rel), text)
	}
	return dir
}

const github = parseRemote('git@github.com:dillyapps/firestrike-net.git')

test('rules: frontmatter with name, repository, description and active', () => {
	const rule = parseRule(
		'---\nname: firestrike-net-rules\nrepository: dillyapps/firestrike-net\ndescription: "Short description"\nactive: false\n---\n\n# Rules\n\nUse tabs.\n',
		'/r.md'
	)
	assert.deepEqual(rule, {
		name: 'firestrike-net-rules',
		repository: 'dillyapps/firestrike-net',
		description: 'Short description',
		roles: undefined,
		active: false,
		body: '# Rules\n\nUse tabs.',
		path: '/r.md'
	})
})

test('rules: active defaults to true; repository and description are optional', () => {
	const rule = parseRule('---\nname: everywhere\n---\nBe brief.', '/r.md')
	assert.ok(typeof rule !== 'string')
	assert.equal(rule.active, true)
	assert.equal(rule.repository, undefined)
	assert.equal(rule.description, undefined)
	assert.equal(rule.body, 'Be brief.')
})

test('rules: a missing name, missing frontmatter or bad active value is skipped', () => {
	assert.equal(parseRule('---\ndescription: x\n---\nbody', '/r.md'), 'no name in the frontmatter')
	assert.equal(parseRule('---\nname:   \n---\nbody', '/r.md'), 'no name in the frontmatter')
	assert.equal(parseRule('# Just markdown', '/r.md'), 'no frontmatter with a name')
	assert.match(String(parseRule('---\nname: x\nactive: maybe\n---\n', '/r.md')), /active must be true or false/)
})

test('rules: CRLF, a BOM, comments and block-scalar descriptions parse like a skill', () => {
	const parsed = parseFrontmatter('﻿---\r\nname: crlf # trailing comment\r\ndescription: >-\r\n  Two lines\r\n  folded.\r\nactive: yes\r\n---\r\nBody\r\n')
	assert.deepEqual(parsed, { fields: { name: 'crlf', description: 'Two lines folded.', active: 'yes' }, body: 'Body\n' })
})

test('rules: loads .md files from subfolders, skips invalid and duplicate ones', () => {
	const dir = rulesDir({
		'a-global.md': '---\nname: global\n---\nAlways run the tests.',
		'dillyapps/firestrike.md': '---\nname: firestrike-net-rules\nrepository: dillyapps/firestrike-net\n---\nUse tabs.',
		'nameless.md': '---\ndescription: no name\n---\nIgnored.',
		'z-dup.md': '---\nname: Global\n---\nDuplicate.',
		'notes.txt': 'not a rule'
	})
	const set = loadRules(dir)
	assert.deepEqual(set.rules.map((r) => r.name).sort(), ['firestrike-net-rules', 'global'])
	assert.deepEqual(set.skipped.map((s) => s.reason.split(' (')[0]).sort(), ['duplicate name "Global"', 'no name in the frontmatter'])
	assert.deepEqual(loadRules(join(dir, 'missing')), { dirs: [join(dir, 'missing')], rules: [], skipped: [] })
})

test('rules: extra folders from rules.json load after the home folder, which wins on duplicate names', () => {
	const home = rulesDir({ 'shared.md': '---\nname: shared\n---\nFrom home.' })
	const team = rulesDir({ 'team.md': '---\nname: team\n---\nFrom the team.', 'sub/shared.md': '---\nname: Shared\n---\nFrom the team.' })
	const missing = join(team, 'missing')
	const set = loadRules(home, [team, missing, home])
	assert.deepEqual(set.dirs, [home, team, missing])
	assert.deepEqual(set.rules.map((r) => [r.name, r.body]), [['shared', 'From home.'], ['team', 'From the team.']])
	assert.deepEqual(set.skipped.map((s) => s.path), [join(team, 'sub', 'shared.md'), missing])
	assert.ok(set.skipped[0]!.reason.includes(`already loaded from ${join(home, 'shared.md')}`), set.skipped[0]!.reason)
	assert.match(set.skipped[1]!.reason, /cannot read the rules folder/)
})

test('rules: repository matching for GitHub, Azure DevOps, URLs and no remote', () => {
	assert.ok(repositoryMatches('dillyapps/firestrike-net', github))
	assert.ok(repositoryMatches('DillyApps/Firestrike-Net', github))
	assert.ok(repositoryMatches('https://github.com/dillyapps/firestrike-net.git', github))
	assert.ok(!repositoryMatches('dillyapps/other', github))
	assert.ok(!repositoryMatches('firestrike-net', github))
	const azure = parseRemote('https://dev.azure.com/contoso/Web%20Shop/_git/api')
	assert.ok(repositoryMatches('contoso/Web Shop/api', azure))
	assert.ok(repositoryMatches('Web Shop/api', azure))
	assert.ok(repositoryMatches('https://dev.azure.com/contoso/Web%20Shop/_git/api', azure))
	assert.ok(!repositoryMatches('dillyapps/firestrike-net', { kind: 'none' }))
})

test('rules: repository matching on GitHub Enterprise', () => {
	const ghe = parseRemote('git@code.contoso.com:dillyapps/firestrike-net.git', ['code.contoso.com'])
	assert.ok(repositoryMatches('dillyapps/firestrike-net', ghe), 'owner/repo matches on any GitHub host')
	assert.ok(repositoryMatches('code.contoso.com/dillyapps/firestrike-net', ghe))
	assert.ok(repositoryMatches('https://Code.Contoso.com/dillyapps/firestrike-net.git', ghe))
	assert.ok(!repositoryMatches('https://github.com/dillyapps/firestrike-net', ghe), 'a URL names one host')
	assert.ok(!repositoryMatches('https://code.contoso.com/dillyapps/firestrike-net', github))
	assert.ok(repositoryMatches('github.com/dillyapps/firestrike-net', github))
})

test('rules: only active rules for this repository or all repositories apply', () => {
	const dir = rulesDir({
		'global.md': '---\nname: global\n---\nA',
		'here.md': '---\nname: here\nrepository: dillyapps/firestrike-net\n---\nB',
		'there.md': '---\nname: there\nrepository: dillyapps/other\n---\nC',
		'off.md': '---\nname: off\nactive: false\n---\nD'
	})
	const { rules } = loadRules(dir)
	assert.deepEqual(rulesFor(rules, github).map((r) => r.name), ['global', 'here'])
	assert.deepEqual(rulesFor(rules, { kind: 'none' }).map((r) => r.name), ['global'])
	assert.deepEqual(
		Object.fromEntries(rules.map((r) => [r.name, ruleVerdict(r, github)])),
		{ global: 'applies', here: 'applies', off: 'inactive', there: 'other repository' }
	)
})

test('rules: roles accept a comma list, a bracket list or a block list; omitted means all roles', () => {
	const roles = (front: string) => {
		const rule = parseRule(`---\nname: x\n${front}---\nbody`, '/r.md')
		assert.ok(typeof rule !== 'string')
		return rule.roles
	}
	assert.deepEqual(roles('roles: architect, reviewer, reviewer-lite\n'), ['architect', 'reviewer', 'reviewer-lite'])
	assert.deepEqual(roles('roles: [Architect, "reviewer"]\n'), ['architect', 'reviewer'])
	assert.deepEqual(roles('roles:\n  - architect\n  - senior-backend\nactive: true\n'), ['architect', 'senior-backend'])
	assert.equal(roles(''), undefined)
	assert.equal(roles('roles:\n'), undefined)
})

test('rules: a rule with roles applies only to workers in those roles', () => {
	const dir = rulesDir({
		'all.md': '---\nname: all\n---\nA',
		'review.md': '---\nname: review\nroles: reviewer, reviewer-lite\n---\nB',
		'arch-here.md': '---\nname: arch-here\nrepository: dillyapps/firestrike-net\nroles: architect\n---\nC'
	})
	const { rules } = loadRules(dir)
	const names = (role?: string) => rulesFor(rules, github, role).map((r) => r.name)
	assert.deepEqual(names('reviewer-lite'), ['all', 'review'])
	assert.deepEqual(names('architect'), ['all', 'arch-here'])
	assert.deepEqual(names('junior-backend'), ['all'])
	assert.deepEqual(names(), ['all', 'arch-here', 'review'], 'without a role only repository and active are checked')
	assert.equal(ruleVerdict(rules.find((r) => r.name === 'review')!, github, 'architect'), 'other role')
	assert.equal(ruleVerdict(rules.find((r) => r.name === 'arch-here')!, { kind: 'none' }, 'architect'), 'other repository')
})

test('rules: the spec carries applied rules after the project context', () => {
	const rule = parseRule('---\nname: firestrike-net-rules\ndescription: House style\n---\nUse tabs.', '/r.md')
	assert.ok(typeof rule !== 'string')
	const spec = composeSpec({ role: 'junior-backend', rolePrompt: 'p', title: 't', inputs: [], context: '## Project context\n\nx', rules: [rule] })
	assert.match(spec, /## Project context[\s\S]*## User rules[\s\S]*### firestrike-net-rules\n\n_House style_\n\nUse tabs\.[\s\S]*## Reporting back/)
	assert.doesNotMatch(composeSpec({ role: 'r', rolePrompt: 'p', title: 't', inputs: [] }), /User rules/)
})

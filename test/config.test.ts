import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { findConfigFile, parseRuleFolders } from '../src/config.ts'

test('config files fall back from the config folder to the repo config, copied from its template when missing', () => {
	const personal = mkdtempSync(join(tmpdir(), 'oa-config-personal-'))
	const repo = mkdtempSync(join(tmpdir(), 'oa-config-repo-'))

	assert.throws(() => findConfigFile(personal, 'roles', repo), /no roles config found/)

	writeFileSync(join(repo, 'roles.template.json'), '{"roles":{}}')
	assert.equal(findConfigFile(personal, 'roles', repo), join(repo, 'roles.json'))
	assert.equal(readFileSync(join(repo, 'roles.json'), 'utf8'), '{"roles":{}}')

	// An existing copy is kept, not overwritten by the template.
	writeFileSync(join(repo, 'roles.json'), '{"edited":true}')
	assert.equal(findConfigFile(personal, 'roles', repo), join(repo, 'roles.json'))
	assert.equal(readFileSync(join(repo, 'roles.json'), 'utf8'), '{"edited":true}')

	writeFileSync(join(personal, 'roles.json'), '{}')
	assert.equal(findConfigFile(personal, 'roles', repo), join(personal, 'roles.json'))
})

test('rules.json lists extra rule folders: ~ is the home folder, relative paths are relative to the file', () => {
	const file = join(tmpdir(), 'oa-config', 'rules.json')
	assert.deepEqual(parseRuleFolders([], file), [])
	assert.deepEqual(parseRuleFolders(['~/team-rules', '../shared', join(tmpdir(), 'abs'), '../shared'], file), [
		join(homedir(), 'team-rules'),
		join(tmpdir(), 'shared'),
		join(tmpdir(), 'abs')
	])
	assert.throws(() => parseRuleFolders({ folders: [] }, file), /expected an array of folder paths/)
	assert.throws(() => parseRuleFolders(['ok', ''], file), /expected an array of folder paths/)
	assert.throws(() => parseRuleFolders([1], file), /expected an array of folder paths/)
})

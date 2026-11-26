import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { rulesSection, type Rule } from './rules.ts'

export type SpecInput = {
	role: string
	rolePrompt: string
	title: string
	inputs: { label: string; text: string }[]
	/** The detected "Project context" section (tracker, code host, instruction files). */
	context?: string
	/** User rules from ~/.orca-agents/rules that apply to this project. */
	rules?: Rule[]
}

const REPORTING = `## Reporting back

Follow the worker contract in your Orca dispatch preamble:

- Send \`worker_done\` exactly once, with the task and dispatch IDs from the preamble and \`--outcome succeeded|failed\`.
- Put your result in \`--body\` as Markdown, in the output format your role describes.
- Ask the coordinator with \`orca orchestration ask\` instead of waiting at a local prompt. Ask only
  for what your role allows; send no progress updates and no broadcasts. The coordinator tracks
  status from Orca and your result.
- Keep each message to at most three lines: the status, the file path, and the blocker or question.
  Point to files by path and line; never paste file contents, diffs, logs or plans. When the
  coordinator needs more detail, write it to a file your role may write and send the path.
- Each "Input from <path>" section above already holds that file's contents. Do not read the file
  again unless the coordinator points you to a later change.
- If your own model provider refuses work because of a rate limit, usage limit or quota, stop and send
  \`worker_done --outcome failed\` with a body that starts with \`RATE_LIMITED:\` and quotes the error.
  The coordinator will hand the task to another provider. Do not retry in a loop.
- Follow the repository's agent instructions. Speak English at B2 level or below.
- Use MCP tools before browsers. Read work items from the tracker named in the project context.
- Keep edits within the assigned scope and preserve other workers' changes.
- Never create commits or push commits. Leave that work to the user.
- Do not create, edit or comment on work items unless the user explicitly asks.
- Do not open pull requests unless the user explicitly asks.`

/** The vendor-neutral spec every provider receives: role prompt, task input, reporting contract. */
export function composeSpec(input: SpecInput): string {
	const rules = rulesSection(input.rules ?? [])
	const sections = [
		`# ${input.title}`,
		`Role: **${input.role}**`,
		input.rolePrompt.trim(),
		...input.inputs.map((i) => `## ${i.label}\n\n${i.text.trim()}`),
		...(input.context ? [input.context.trim()] : []),
		...(rules ? [rules] : []),
		REPORTING
	]
	return `${sections.join('\n\n')}\n`
}

export function readInputs(texts: string[], files: string[]): { label: string; text: string }[] {
	return [
		...texts.map((text, i) => ({ label: texts.length > 1 ? `Task input ${i + 1}` : 'Task input', text })),
		...files.map((file) => ({ label: `Input from ${file}`, text: readFileSync(file, 'utf8') }))
	]
}

export function writeSpec(specDir: string, role: string, spec: string, now = Date.now()): string {
	mkdirSync(specDir, { recursive: true })
	const path = join(specDir, `${new Date(now).toISOString().replace(/[:.]/g, '-')}-${role}.md`)
	writeFileSync(path, spec)
	return path
}

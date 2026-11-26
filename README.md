# orca-agents

A proof of concept for a multi-provider agent team on top of [Orca](https://github.com/stablyai/orca).
A coordinator agent runs a work item from Jira, Azure Boards or GitHub Issues through a backend
team: Architect, Reviewer, Reviewer-lite, Senior-backend and Junior-backend. The tracker and the
code host (GitHub, GitHub Enterprise or Azure DevOps) are detected from the project you run it in.
Each role runs as a separate Orca worker on whichever provider has room:
Codex, GitHub Copilot or Claude. Every provider has two budgets: how much of the usage
**included in your plan** the router may use, and how much **extra (paid) usage** it may cause on
top, such as overage, on-demand spend, and models your plan does not include. When both are used
up, or a worker stops on a rate limit, the work moves to the next provider in that role's fallback
chain.

## How it works

```
you ─▶ coordinator agent in Orca  (skills: project-manager + Orca's orchestration)
          │  orca-agents start --role junior-backend ...
          ▼
       orca-agents router ◀── usage: Codex app-server, Copilot CLI quota,
          │                          claude -p /usage, cooldowns
          │  first candidate in config/roles.json whose included usage, or else
          │  extra usage, is within its limits
          ▼
       orca orchestration worker-start --agent codex|copilot|claude [--model ...]
          ▼
   architect ─▶ junior-backend ─▶ reviewer or reviewer-lite
                     │                    │
                     └▶ senior-backend ◀───┘ changes requested

   One child worktree is shared by the roles for this work item.
   A lite review can escalate to the full reviewer.
```

There are two kinds of fallback:

- **Before a start:** for each candidate, the router works out how the model is billed (free,
  included, a named included pool, or extra) and checks the matching limits. It skips the candidate
  when those limits are used up, when the provider is cooling down, or when Orca refuses the launch
  (missing CLI, unknown model id).
- **After a failure:** `orca-agents retry --dispatch <id>` reads the worker's output, and if it looks
  like a quota error, cools that provider down until its window resets (or the "try again in ..."
  time from the error). It then stops the stuck worker and restarts the same task on the next
  provider **in the same worktree**, so partial work is kept.

The roles are vendor-neutral prompts (`roles/*.md`). The same backend prompt runs on Codex, Copilot or
Claude, so any provider can stand in for another.

The architect reads the work item and relevant documents, defines contracts and prepares tickets with
acceptance criteria and implementation plans. Junior-backend is the default implementer;
Senior-backend handles complex work and escalations. Reviewer checks risky changes;
Reviewer-lite checks mechanical work with low risk and escalates when needed. Small fixes can
skip the architect when the coordinator can prepare one clear ticket.

The coordinator chooses roles and handles review verdicts through the skill; the CLI routes and
starts individual workers. These role decisions are not a hardcoded automatic state machine.
Scope and project rules (backend only, no changesets, a default project) come from the project's
own `AGENTS.md` and other instruction files, not from orca-agents. Without them, workers cover
backend work. Workers leave commits, pushes and pull requests to the user.

## Project detection

orca-agents has no tracker settings. `orca-agents start` looks at the project in the current
folder and writes what it finds into every worker's spec as a **Project context** section:

| What | Evidence |
| --- | --- |
| Code host | The `origin` remote: `github.com` is GitHub; a [GitHub Enterprise host](#github-enterprise) is GitHub Enterprise; `dev.azure.com` or `*.visualstudio.com` is Azure DevOps. |
| Tracker | 1. `--item <ref>`: a URL, `ABC-123` (Jira), `AB#123` (Azure Boards), `owner/repo#12` or `#12` (GitHub).<br>2. A `tracker = "jira"` line (or `azure-boards`, `github`) in `agents.toml` or another instruction file.<br>3. Links and mentions in `agents.toml`, `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md` (strongest), then `README.md`, `CONTRIBUTING.md` and pull request templates: `*.atlassian.net`, `dev.azure.com/.../_workitems`, `github.com/.../issues` (or the same on a GitHub Enterprise host), `AB#123`.<br>4. The last 200 commits and branch names: repeated `ECOM-123` keys (Jira), `AB#123` (Azure Boards), `Fixes #12` (GitHub).<br>5. `.github/ISSUE_TEMPLATE/`, then the code host itself as a weak hint. |
| Documents | Confluence, GitHub wiki (github.com or GitHub Enterprise) and Azure DevOps wiki links in the same files. |
| Instructions | Which of those files exist, so workers read and follow them. |

Version-like keys such as `UTF-8` or `SHA-256` never count as Jira. Run `orca-agents project` in a
repository to see the result, the evidence and the exact section workers receive. When the tracker
is not clear, the coordinator asks once and suggests one line for the project's `AGENTS.md`, such as
"Work items are tracked in Jira at contoso.atlassian.net, project ECOM.", so the next run finds it.

### GitHub Enterprise

GitHub Enterprise Server and GitHub Enterprise Cloud work like github.com: remotes, issue and wiki
links, `owner/repo#12` and `#12` references, and rule `repository` fields. These hosts count as
GitHub:

- `github.com`, and GitHub Enterprise Cloud with data residency (`*.ghe.com`). Enterprise Cloud
  on github.com itself needs nothing extra.
- A GitHub Enterprise Server named `github.<company>.<tld>`, such as `github.contoso.com`.
- Any other host listed in `ORCA_AGENTS_GITHUB_HOSTS` (comma or space separated), set in `GH_HOST`,
  or signed in to with `gh auth login --hostname <host>` (read from gh's `hosts.yml`).

`#12` and `owner/repo#12` resolve on the project's own GitHub host. Workers are told to read issues
and pull requests on that host, with `gh ... --repo <host>/<owner>/<repo>` or a GitHub MCP server
set up for it (see [MCP servers](#mcp-servers-for-the-workers)). When `orca-agents project` shows a
GitHub Enterprise Server remote as an unknown host, add the host to `ORCA_AGENTS_GITHUB_HOSTS`.

## Included usage and extra usage

Each candidate's model has a billing class, set per provider in `models` (exact ids or globs such
as `gpt-*`; `default` covers unlisted models and `null`):

| Class | Meaning | Limits checked |
| --- | --- | --- |
| `free` | Unmetered on your plan (for example a Copilot model with a 0x multiplier). | Cooldowns only. |
| `included` | Draws from the plan's included usage. | Every included window of the plan. |
| a pool name | Draws from one named included pool, for probes that report pools. | That pool and the plan total. |
| `extra` | Not part of the plan, always billed on top. | Extra usage limits only. |

The limits live in `limits` per provider:

```json
"limits": {
  "included": { "maxUsedPercent": 90, "pools": { "other-models": 80 } },
  "extra": { "enabled": false, "maxSpendUsd": 10, "maxUsedPercent": 50 }
}
```

- `included.maxUsedPercent` is how much of the included usage the router may use; `pools` overrides
  it per pool. Past that point a run only goes ahead as extra usage.
- `extra.enabled` switches paid usage on. It needs at least one cap:
  `maxSpendUsd` (a monthly cap in USD, for probes that report spend, such as GitHub billing) or
  `maxUsedPercent` (a share of the spend limit set in the provider account).
- Extra usage **fails closed**: when the probe cannot measure the figure a cap is defined on, no
  paid usage is allowed. Included usage that cannot be measured is allowed by default
  (`"unknownUsage": "allow"`); set it to `"skip"` to be strict there too.
- `"allowExtra": false` on a role candidate keeps that role from ever causing paid usage on that
  provider. The defaults set it for every architect candidate, so only implementation and review
  can spend money, and only once you enable `extra`.
- `limits.maxDispatchesPerDay` is an optional local cap, counted from the dispatches this tool started.

Out of the box, extra usage is **off for every provider**, so nothing beyond your plans is spent
until you turn it on.

## Requirements

- Orca with its CLI registered (Settings > Orca CLI) and **Settings > Experimental > Orchestration**
  turned on.
- Node.js 22.18 or newer. It runs the TypeScript sources directly, with no build step and no runtime
  dependencies.
- The agent CLIs you enable, signed in: `codex`, `copilot`
  (and `claude` if you enable it).
- Optional: `gh`, signed in with a token that has the **Plan (read)** user permission, for the
  optional `github-billing` probe. The default Copilot quota probe only needs your Copilot CLI sign-in.
- MCP servers for the trackers and documents your projects use: Atlassian (Jira, Confluence),
  Azure DevOps, GitHub. See below.

## Install

```bash
git clone https://github.com/samhoogantink/orca-agents
cd orca-agents
npm link                     # puts `orca-agents` on your PATH
orca-agents doctor           # checks Orca, the agent CLIs and gh

# Skills for the coordinator agent (the installer asks which agents to add them to)
npx skills add samhoogantink/orca-agents --skill project-manager
npx skills add stablyai/orca --skill orchestration
```

`npm install` is only needed for the tests and the typecheck.

## Configure

`config/providers.json` defines the providers:

| Field | Meaning |
| --- | --- |
| `enabled` | Whether the router may use it. `claude` is off by default. |
| `orcaAgent` | The id Orca's `--agent` takes (`orca agent installed --json` lists them). |
| `cli` | The executable, or a list of alternatives, when it differs from the agent id. |
| `supportsModelFlag` | Whether Orca's `worker-start --model` works for this agent. |
| `usage` | How usage is read (see the table below). |
| `limits` | Included and extra usage limits (see above). |
| `models` | Billing class per model. |
| `vendors` | Who made each model (`openai`, `anthropic`, `google`, ...), by id or glob; `default` covers the agent's own default model. See [Cross-vendor review](#cross-vendor-review). |
| `cooldownMinutes` | Cooldown after a rate limit when no reset time is known. |

`config/roles.json` defines each role's prompt, default worktree and fallback chain. The defaults
put Copilot first for architecture and both reviewers, and Codex first for both backend roles. A review always runs on a model from another vendor than the
latest implementer (see below).
Models are provider defaults (`null`). Pin provider-specific models (see below) when you want
different model strengths for senior and junior work or full and lite reviews.

### Cross-vendor review

A review started with `--review-of <dispatchId>` never runs on a model from the same vendor as the
code it reviews. If a developer wrote the code on Codex (OpenAI), the reviewer runs on a Claude or
Gemini model, whichever comes first in the reviewer's chain and has room. The rule applies to
`reviewer` and `reviewer-lite`, follows reroutes of the developer, and stays in force when a
review itself is rerouted with `retry`. The architect and developers have no vendor rule.

The vendor comes from the provider's `vendors` map, then from well-known model ids (`claude-*`,
`gpt-*`, `o3`, `gemini-*`, ...), then from `vendors.default`. Codex defaults to `openai` and Claude
to `anthropic`. Copilot runs models from several vendors, so its vendor is unknown until you set
`vendors.default` to the vendor of your `COPILOT_MODEL`. This rule fails closed:

- A candidate whose vendor cannot be told is skipped as a reviewer.
- Code from a dispatch whose vendor cannot be told cannot be reviewed.
- When no candidate from another vendor has room, the review does not start (not even with
  `--allow-over-budget`). Enable a second vendor, or wait for one to become available.

`model: null` means the agent's own default model. To pin models, fill in ids from your CLIs
(`/model` in Codex, `copilot help` for Copilot), for example:

```json
{ "provider": "codex", "model": "<codex model id>", "effort": "high" }
```

and give those models a billing class in that provider's `models` map.

The defaults are committed as `config/providers.template.json`, `config/roles.template.json` and
`config/rules.template.json`. `config/providers.json`, `config/roles.json` and `config/rules.json`
are gitignored and hold your settings. When one is missing, it is created as a copy of its
template the first time the config is read; edit the copy.

You can also keep personal settings in `~/.orca-agents/config/` (or the folder in
`ORCA_AGENTS_CONFIG_DIR`). That folder takes precedence over `config/` once it has a
`providers.json`. A file missing there is read from `config/` (copied from its template if needed).

### User rules

Put your own rules for workers in `~/.orca-agents/rules/` (subfolders are fine). Each rule is a
Markdown file with frontmatter, like a skill:

```markdown
---
name: firestrike-net-rules
repository: dillyapps/firestrike-net
description: A small short description about the rules
roles: architect, reviewer, reviewer-lite
active: true
---

Rules for workers, in Markdown.
```

| Field | Meaning |
| --- | --- |
| `name` | Required. Files without a name are skipped, and so is a second file with the same name. |
| `repository` | Optional. The rule applies only in this repository: `owner/repo` (GitHub, on any host), `host/owner/repo` (GitHub or GitHub Enterprise on that host), `org/project/repo` or `project/repo` (Azure DevOps), or a remote URL. It is matched against the `origin` remote, ignoring case. Without it, the rule applies in every repository. |
| `description` | Optional. Shown to workers above the rule. |
| `roles` | Optional. The rule applies only to workers in these roles from `config/roles.json`, as a comma-separated list (`architect, reviewer`), `[architect, reviewer]` or a YAML list. Without it, the rule applies to every role. |
| `active` | Optional, `true` by default. Set it to `false` to keep the file but stop using it. |

To load rules from more folders, such as a shared team repository, list them in
`config/rules.json` (created from `config/rules.template.json`, like the other config files):

```json
["~/team-rules", "D:/work/shared-rules"]
```

`~` is your home folder, and relative paths are relative to `rules.json`. These folders are read
after `~/.orca-agents/rules/`, so a rule there wins over one with the same name in an extra folder.
A listed folder that does not exist is reported as skipped.

`orca-agents start` adds the rules that apply as a **User rules** section to every worker's spec,
after the project context. `orca-agents rules [--role <role>]` lists every rule, whether it
applies in the current repository (and role), unknown role names, and why files were skipped;
`orca-agents project --role <role>` shows the section that role's workers receive.

### How usage is measured

| Provider | Probe | Included usage | Extra usage |
| --- | --- | --- | --- |
| Codex | `codex-app-server` | 5-hour and weekly windows from `codex app-server` (`account/rateLimits/read`), as Orca's status bar reads them. | Not measured, so it stays off. |
| Copilot | `copilot-cli` | Account premium-interaction quota from `account.getQuota` over the signed-in CLI's headless JSON-RPC transport, including unlimited entitlements. | Not measured, so paid routes stay blocked. |
| Claude | `claude-cli` | Session and weekly windows from `claude -p /usage`, which Claude Code answers itself without a model call. Falls back to the `claude-statusline` feed. | Not measured. |
| Claude | `claude-statusline` | 5-hour and weekly windows saved by `scripts/claude-statusline.mjs` from Claude Code's status line. | Not measured. |

Results are cached for five minutes; pass `--refresh` to probe again.

The Claude CLI probe runs `claude -p /usage --output-format json` in a temporary folder and reads
the same text `/usage` shows in a session (subscription plans only). A weekly limit scoped to some
models, such as `Current week (Sonnet only)`, becomes a named pool (`sonnet-only`); map those models
to that billing class in `models` to have it checked. If Claude Code ever answers `/usage` with a
model call (any turn or cost in the result), the probe reports unknown, stops calling the CLI for
24 hours and uses the status-line feed meanwhile. The call itself runs on `haiku` with no tools, no
MCP servers and `--max-budget-usd 0.01`, so such a call stays cheap. To keep the status-line feed as
a fallback, set up `scripts/claude-statusline.mjs`; without it, a failed CLI probe reports unknown.

The Copilot probe uses `copilot --headless --stdio --no-auto-update` and reads
[account quota](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/usage-and-billing#account-quota-and-premium-interactions)
without creating a session or sending an AI prompt. It uses Copilot's existing sign-in, including
company accounts; no GitHub billing permission or configured monthly allowance is needed. Missing
or invalid quota data reports as unknown, not zero usage. Quota counts do not measure dollar spend,
so a configured USD cap alone cannot enable paid routes with this probe.

To measure dollar spend on a personally billed plan, set Copilot's `usage` to
`{ "probe": "github-billing" }` with `unit` (`premium_request` or `ai_credit`) and
`monthlyAllowance`. It reads the personal billing API through `gh` and falls back to the Copilot
CLI quota probe when billing is unavailable.

## MCP servers for the workers

The architect reads work items, linked pull requests and documents. Add the servers for the
trackers and hosts your projects use to every CLI that can run those roles:

| Project uses | MCP server | Without it |
| --- | --- | --- |
| Jira, Confluence | Atlassian: `https://mcp.atlassian.com/v2/mcp` | None; the worker reports the source as unavailable. |
| Azure Boards, Azure DevOps Repos | Azure DevOps: `npx -y @azure-devops/mcp <your-org> --authentication azcli` | `az boards` and `az repos` (Azure CLI with the `azure-devops` extension). |
| GitHub Issues, GitHub pull requests | GitHub's MCP server (built into Copilot CLI) | `gh issue view` and `gh pr view`. |
| GitHub Enterprise Issues and pull requests | GitHub's MCP server with `GITHUB_HOST` set to your host (`https://github.contoso.com` or `https://contoso.ghe.com`) | `gh issue view --repo <host>/<owner>/<repo>` after `gh auth login --hostname <host>`. |

Codex:

```bash
codex mcp add atlassian --url https://mcp.atlassian.com/v2/mcp
codex mcp add azure-devops -- npx -y @azure-devops/mcp <your-org> --authentication azcli
```

Copilot CLI: run `/mcp add` inside `copilot` and enter the same command and URL (they are stored in
`~/.copilot/mcp-config.json`). For GitHub with Codex, sign in to `gh` (`gh auth login`) or add
GitHub's MCP server as its documentation describes.

Run `az login` first for the `azcli` authentication. The Atlassian server signs you in through the
browser on first use.

## Run it

In Orca, open your project and start an agent to be the coordinator (Codex is a cheap choice).
Then ask it:

> Use orca-agents to implement ECOM-123.

Any reference works: `https://contoso.atlassian.net/browse/ECOM-123`, `AB#1234`, a
`dev.azure.com/.../_workitems/edit/1234` URL, a GitHub or GitHub Enterprise issue URL,
`owner/repo#12` or `#12`.

The coordinator follows `skills/project-manager/SKILL.md`: it creates an Orca Run, starts each role
with `orca-agents start`, passes tickets and decisions along as files, reroutes failed workers
with `orca-agents retry`, and leaves the changes uncommitted in the shared worktree for you to
review. Specs, decisions, status and review reports live under `.agent-work/<item>/`.

You can drive the same steps by hand. Rehearse with `--dry-run`, which prints the Orca commands
instead of running them and keeps a separate state file:

```bash
orca-agents project --item ECOM-123
orca-agents usage
orca-agents route --role architect
orca-agents start --role architect --item ECOM-123 --input "Read the work item and prepare backend tickets in .agent-work/ecom-123/feature.md. Report absolute paths." --dry-run
orca-agents start --role junior-backend --item ECOM-123 --title "ECOM-123: T01" --input "Implement T01" --input-file <feature.md> --worktree dispatch:<architectDispatch> --dry-run
ORCA_AGENTS_DRY_READ="You've hit your usage limit. Try again in 3 hours." \
  orca-agents retry --dispatch <dispatchId from above> --dry-run
orca-agents start --role reviewer-lite --item ECOM-123 --title "ECOM-123: T01" --input "Review T01; report to <absoluteReviewPath>" --input-file <feature.md> --review-of <developerDispatch> --dry-run
# For risky work or a lite verdict of ESCALATE, use --role reviewer.
# For difficult implementation or a junior's first review rejection, use --role senior-backend
# with --worktree dispatch:<latestDeveloperDispatch> and the ticket/review input files.
```

`start` and `route` print how each run is billed (`free`, `included` or `extra`) and why other
candidates were skipped.

## Usage-gated scheduled runs

Orca automations accept a `--precheck` command and skip the run when it exits non-zero, so a
nightly job can wait for quota:

```bash
orca automations create --name "Nightly triage" --trigger daily --time 02:00 \
  --provider codex --repo my-repo \
  --precheck "orca-agents usage check --provider codex --max 70" \
  --prompt "Triage new bugs and summarize them" --disabled
```

## Commands

| Command | What it does |
| --- | --- |
| `usage [--refresh] [--json]` | Included and extra usage per provider, and whether the router would use it. |
| `usage check --provider <id> [--model <id>] [--max <pct>] [--strict]` | Exit 0 when the provider (and model) is usable, 1 when not. |
| `project [--item <ref>] [--role <role>] [--json]` | Shows the tracker, code host, documents and instruction files detected for the current project, with the evidence, and the context workers receive. |
| `rules [--role <role>] [--json]` | Lists the user rules in `~/.orca-agents/rules/` and the folders in `config/rules.json`, whether each applies in the current repository (and role), and files that were skipped. |
| `route --role <role> [--avoid <ids>]` | Shows which provider the role would get, how it is billed, and why. |
| `start --role <role> [--item <ref>] --input <text> \| --input-file <path> ...` | Creates the Orca task with the project context and starts the worker on the routed provider. `--item` also sets the default title and child worktree name. `--review-of <dispatchId>` runs in that worker's workspace on a model from another vendor. `--worktree dispatch:<id>` reuses a workspace. |
| `retry --dispatch <id> [--reason auto\|rate-limit\|other]` | Reroutes a failed or stuck worker to the next provider. |
| `cooldown list \| set --provider <id> [--minutes n] \| clear` | Inspect or change cooldowns. |
| `doctor` | Checks the Orca CLI, the runtime and the agent CLIs. |

State (cooldowns, dispatch records, usage cache, generated task specs) and user rules live in
`~/.orca-agents` (set `ORCA_AGENTS_HOME` to move it). Set `ORCA_AGENTS_GITHUB_HOSTS` to name
[GitHub Enterprise](#github-enterprise) hosts that are not detected on their own. Set `ORCA_AGENTS_ORCA_BIN` if your Orca executable has another
name. On Linux the default is `orca-ide`, as Orca's skills recommend.

## Limitations

This is a proof of concept.

- **Not yet run against a live Orca.** The Orca commands follow Orca's CLI docs and command specs,
  and receipts are parsed defensively, but try `--dry-run` and one manual `start` before letting a
  coordinator loose.
- **Usage is checked when a worker starts, not during its run.** A long coding run can still go past
  an included limit while it works. The caps decide whether the *next* run may start.
- **The Codex probe uses a private API**, the same one Orca's status bar uses. It can
  change without notice; the probe then reports unknown usage.
- **The Claude CLI probe parses display text.** `/usage` output is meant for people and can change
  in any Claude Code release; lines it cannot read report unknown usage, not zero. Reset times are
  shown without a year and are read as the next matching date.
- **Copilot model per launch:** Orca's `worker-start` does not pass `--model` to Copilot. Set
  `COPILOT_MODEL` in Orca (Settings > Agents > GitHub Copilot > Environment) or `model` in
  `~/.copilot/settings.json`, and set `models.default` to that model's billing class.
- **Copilot quota** depends on the installed CLI supporting `account.getQuota`. Older versions or
  a missing sign-in report unknown usage. The CLI quota probe does not report paid dollar spend;
  use the `github-billing` probe if your personally billed plan exposes that data.
- **Windows:** npm shims (`codex.cmd`, `copilot.cmd`) are started through `cmd.exe` with
  hand-quoted arguments. That is best effort.
- **The coordinator needs to run `orca` and `orca-agents` outside its sandbox**, because both talk to
  the Orca runtime and write `~/.orca-agents`. Orca's default (Yolo) launch allows that; in Manual
  mode, approve those commands.
- State is per machine and not locked, so two coordinators starting workers at the same moment can
  overwrite each other's records.

## Development

```bash
npm install
npm test            # node --test, including fake codex, copilot and claude CLIs
npm run typecheck   # tsc --noEmit
```

```
config/      providers.template.json, roles.template.json, rules.template.json (copied to providers.json, roles.json, rules.json on first use)
roles/       vendor-neutral role prompts
skills/      coordinator skill (project-manager)
scripts/     claude-statusline.mjs
src/         cli, router, pipeline (start/retry), Orca wrapper, usage probes
test/        unit tests and fixtures
```

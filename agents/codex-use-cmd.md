# Using Command Code from Codex

Read this guide when the user asks you to use Command Code (`cmd`) while working
on a project. The user wants productive delegation, reusable context and verified
results, without repeating these instructions in every Codex chat.

This guide authorizes using Command Code for bounded subtasks within the user's
current request. It does not authorize unrelated work, production changes,
publishing, force-pushing, merging, exposing secrets or changing models/accounts.
Follow the current chat's instructions and the project's AGENTS.md first. For
VPS Pilot, also read `agents/goal.md` and the applicable implementation plan.

## Responsibility and division of work

The user's preferred workflow is Command Code first for implementation, to
reduce Codex code-writing cost. Codex coordinates, specifies and independently
reviews; Command Code should write most feature code, including native/backend
logic, UI and meaningful tests. Do not routinely keep the main implementation
with Codex and delegate only tests. Precise specifications and review are the
way to handle complex or sensitive logic within the authorized scope.

Break a feature into bounded implementation tasks with exact interfaces,
invariants, allowed files and acceptance tests. Have Command Code implement a
coherent slice, inspect the actual diff, run relevant checks, then resume the
same chat with concrete review findings and failing evidence for fixes. Codex
should normally request those fixes instead of immediately rewriting the code.
Avoid unnecessary rereads, duplicate implementations and ceremonial delegation
of tiny edits. Keep prompts concise while preserving the necessary constraints.

Codex may directly edit this workflow guide, documentation, trivial integration
fixes, or make a targeted repair when the CLI is blocked, unavailable or repeatedly
fails. Explain a substantial fallback candidly. Do not let the cost preference
weaken validation, authorize unrelated work or cause endless retry loops. Actual
savings depend on CLI pricing, inference usage and rework; do not promise them.

Keep architecture, integration, scope and safety decisions with Codex. For VPS
Pilot, preserve native approval gates, server identity checks, secrets handling,
open-session lifetime and disposable-fixture requirements. Never let a delegated
agent validate dangerous actions against the user's important VPS.

Before delegating, inspect enough code to specify the task accurately. Give:

- The exact goal, accepted behavior and relevant source files.
- Exact IPC/function contracts, types, state transitions and integration points.
- Race/failure behavior, bounds and concrete examples of accepted/rejected input.
- The files it may edit and files/resources it must leave alone.
- Applicable project instructions and safety constraints.
- Required checks and the expected result/report.
- A stopping condition for blockers, repeated failures or exhausted turns.

Do not let Codex and Command Code edit the same files concurrently. Independent
work can proceed while the CLI runs, but mutations to shared files, index,
branches and lockfiles must be coordinated. The delegate must not commit, push,
merge, install dependencies or modify configuration unless specifically included
in its authorized task. Review its resulting diff before accepting it.

## Verified local setup

Verified on 2026-11-01; recheck `cmd --help` when capabilities differ:

- Command Code v1.84.0 was installed as `cmd`; `command-code` was also present.
- The configured model was `deepseek/deepseek-v4.1-flash` via Command Code.
  Do not silently change it or promise the provider will always route identically.
- All 29 skills from `aicodeking/deepseek-stack` were installed globally under
  `~/.commandcode/skills/`, pinned to commit
  `d4f1ebe72e8314c3a0c6135bb82f623c650f7218`.
- Source metadata/license are under
  `~/.commandcode/skill-sources/deepseek-stack/`.
- `cmd skills list` confirmed discovery. A real run read `ds-verify-loop`, wrote
  a TypeScript implementation and tests in `/tmp`, and passed two tests with
  thirteen assertions. Codex independently inspected and reran them.

These are workflow skills, not a model upgrade or evidence of parity with Opus.
Do not present a successful small test as proof of broad coding quality.

## Start a bounded run

Prefer non-interactive runs that exit on completion. For substantive work, save a
named session so related follow-ups retain context. Example, with a task-specific
name and a fully specified prompt:

```sh
cmd --yolo --safe-mode --skip-onboarding --no-auto-update \
  --name "vps-pilot-configuration-detection" --max-turns 12 \
  -p 'Read AGENTS.md and agents/goal.md. Implement the bounded task described here. Edit only the listed files, preserve the stated safety policies, run the named checks, and report exact changes and observed results. Do not commit, push, merge, contact a VPS, inspect credentials or change configuration.'
```

Replace the generic task text with a real specification before executing. Choose
an appropriate finite turn cap; 12 is an example, not a universal limit. A cap-hit
is not completion. Inspect any partial changes before resuming or integrating.

The user permits `--yolo` for these delegated tasks. It bypasses CLI permission
prompts; it does not expand the user's authorized scope or override project
safety rules. Give explicit boundaries even with this flag.

`--safe-mode` loads built-in mods only; the verified run still discovered installed
skills. Do not pass `--no-skills` when expecting DeepSeek Stack to be available.
Use `--no-session` only for disposable smoke tests or genuinely unrelated one-off
work whose context will not be needed later. Saved sessions may contain prompts,
source excerpts and tool output: never include credentials or confidential output.

Start the process using the execution tool, retain its process/session handle and
poll it until it finishes. An execution-tool handle is not a saved Command Code
chat ID. Preserve both identities separately when available.

## Resume, fork or start fresh

**Resume the exact saved chat** for a follow-up on the same feature, remaining
steps in its plan, a test failure caused by its previous diff, or review fixes
where prior decisions are still valid:

```sh
cmd --yolo --safe-mode --skip-onboarding --no-auto-update \
  --resume "vps-pilot-configuration-detection" --max-turns 8 \
  -p 'Continue this same task. Here is the verified current state, changed files and exact failing check. Resolve only the remaining issue within the original boundaries.'
```

Use a unique session ID or transcript path if names are ambiguous. Help also
supports `--session <path|id>`. Do not guess undocumented output formats or
session-file locations; use supported CLI discovery and its reported identities.

`--continue` / `-c` resumes the most recent conversation. Prefer explicit resume:
the most recent chat might belong to another task or have been created by the
user in another terminal.

**Fork a saved chat** when useful background should carry over into a separate
approach or related task while leaving the original conversation untouched:

```sh
cmd --yolo --safe-mode --skip-onboarding --no-auto-update \
  --resume "vps-pilot-configuration-detection" --fork-session \
  --name "vps-pilot-configuration-review" --max-turns 8 \
  -p 'Review the specified current diff within these boundaries. Revalidate prior assumptions against the current files.'
```

A fork inherits earlier conversation context. It is not an independent review
when independence from the author's assumptions matters; use a fresh session
with a concise evidence handoff for that case.

**Start a fresh named chat** for unrelated features, substantially changed scope,
an overloaded conversation, or persistent incorrect assumptions. Do not keep one
chat alive indefinitely or create a new chat for every small follow-up.

A context handoff should contain only:

1. Goal, scope and protected resources.
2. Current commit/branch and relevant uncommitted changes.
3. Decisions supported by current code or observed results.
4. Checks run, their actual outcomes and unresolved errors.
5. Exact next task, allowed files and acceptance criteria.

Before acting on an old chat's conclusions, confirm them against current files.
Keep a short non-secret progress note in the task's existing plan/document when
useful. Do not create an unsolicited pile of progress files or commit transcripts.

## Detect drift and recover

Watch for invented APIs/files, claimed checks without tool evidence, ignored
constraints, unrelated edits, contradictions with current code, or repeated
patches based on the same failing assumption. Do not rely on the model to diagnose
its own reliability or judge context size from message count alone.

After the same failure twice, pause the loop and examine its shared assumption.
Use `ds-unstick` if appropriate. For a long or unreliable conversation, use a fresh
session with the verified handoff above, rather than blindly resuming or forking
contaminated context. Inspect and preserve useful partial work; undo only changes
that are clearly this task's own and incorrect. Never reset the user's work.

Useful installed workflows include `ds-plan-loop`, `ds-blueprint`,
`ds-verify-loop`, `ds-unstick`, `ds-context-reset`, `ds-ledger` and
`ds-review-loop`. Invoke the smallest relevant workflow. Do not automatically run
multi-model swarms, repeated parallel attempts or shipping workflows for every
change. Installed `ds-ship`/PR skills do not grant permission to publish or merge.

## Process lifetime and cleanup

A saved conversation does not require a running process. Let each bounded run
exit, then resume its saved chat in a later bounded process when needed.

- Do not leave idle interactive `cmd` sessions running.
- Do not launch replacement processes while the previous one is unaccounted for.
- Track each process until normal exit, failure or deliberate termination.
- If a run stalls, inspect its latest output and activity, interrupt through its
  known process handle, and confirm exit before replacing it. If it does not
  stop, terminate only the specific process/process group owned by this task.
- Never use a broad `pkill cmd` or kill the user's separate sessions.
- Keep the user informed during longer runs and waits; avoid blocking waits
  longer than 60 seconds without an opportunity for a progress update.

If authentication fails, report the actual error and let the user authenticate
with `cmd login`. Do not read tokens, print auth files, change accounts or repeatedly
retry the same authentication failure. The previous unauthenticated attempt made
no edits; a later attempt succeeded after the user logged in.

## Verification and reporting

An agent saying “done” is not evidence. Inspect the actual edited files and diff,
check scope and safety, and run the relevant checks yourself or inspect the real
check output from a trusted run. Review test quality; do not accept weakened
assertions or mocked-away behavior merely to get green results.

For VPS Pilot changes, run `bun run check`, `bun run build` and relevant Rust
checks, plus the integration/browser tests justified by the change. Use only
explicit disposable fixtures for server integration. A `/tmp` CLI smoke test does
not require changing or rebuilding VPS Pilot, and does not prove VPS functionality.

Report candidly whether Command Code actually wrote code, only reviewed/read,
failed before editing, or stopped with partial work. Include meaningful validation
and any remaining limitations. Do not claim its work as independently verified
until you have verified it. Never hide a failed CLI attempt or invent test results.
When summarizing a delegated feature, distinguish Command Code's implementation
from Codex's specification, review, validation and any direct repairs.

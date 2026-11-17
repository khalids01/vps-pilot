# PM2

Open a connected server's PM2 page and Refresh. Status and recent logs are
explicit, account-scoped requests; process environments are not returned. Restart
and Restart selected require a preview and independently verify online status.

Deployments → New app saves one ordered command list. Add connected servers,
select each server's PM2 process and choose its project directory with Browse.
Steps can be disabled, removed or moved up. Save workflow acknowledges SQLite
persistence; a save failure keeps the draft. Concurrent stale saves are rejected.
Workflow definitions must not contain credentials; output is never persisted.

Select app/server bindings and Deploy selected. The review lists exact servers,
directories, commands and PM2 targets. Deployments run sequentially by server and
stop at the first failure. Retry full workflow reruns commands from the beginning;
Skip failed and continue omits that deployment. Stop after current prevents future
work without killing a migration. Nothing automatically retries on reconnect.

Each command runs as the SSH account in a new Bash process at the project folder.
NVM Node and common user-tool paths are included; interactive shell startup is
not sourced. No automatic sudo or environment/working-directory inheritance
between steps. A per-account PM2 lock prevents overlapping app deployments even
through different profiles. A step has a 15-minute bound; native batches have a
30-minute bound and bounded output. SSH loss can leave uncertain remote work;
inspect its state before retrying. The final check certifies PM2 online only.
Git rollback, database rollback, PM2 ecosystem edits, HTTP health checks, SSH
proxies and automatic server connection are outside this increment.

Validation: see tests/fixtures/README.md. Full Rust suite: 163 passed, five existing
integration tests ignored; two PM2 browser cases passed. Frontend check/build and
IPC capability coverage passed. Existing unrelated nonminimal_bool warnings are
excluded from strict Clippy checks. Builds retain the existing large-chunk notice.

## Project actions update

The latest UI detects PM2 before showing management. Project menus expose Deploy,
Restart, Logs, Edit commands and every saved command (including steps disabled
from the full deployment). Both the saved editor and selected-project command
editor support drag/drop and an accessible move-up control. Select processes and
Run commands to create or reuse a list; helper commands do not implicitly restart.
Save list creates a reusable command preset without server bindings. Each selected
project uses its PM2 cwd; saved deployments respect explicit directory overrides.
A failure stops only its project; other selected projects continue. This replaces
the earlier pause-entire-batch description. Retry failed projects reruns only the
failed workflows, from their beginning. No automatic Git/database rollback.

The SSH count in the remote status header displays connected saved profiles and
opens account/address/port details. It does not expose credentials or count PTY,
SFTP and monitoring channels as separate server connections.

## Manage env

Project Actions → Manage env explicitly reads .env (or a selected named .env file)
over SFTP. Values are masked; bulk paste previews keys and duplicate/existing-key
conflicts, defaults to preserving existing values and supports explicit replacement.
Existing file duplicates must be resolved before saving. Standard dotenv exports,
comments, quoted/multiline values and literal substitutions are parsed without
shell execution or expanding variables. Unchanged statements/comments and CRLF
are retained; edited values must round-trip exactly or saving is refused.

Save review names the remote file and variable count without displaying values.
The existing SFTP transaction enforces fresh source/revision, stale content checks,
private backup, atomic rename and owner-only mode. Missing files are created only
on confirmed save. System/SSH/protected paths and symlinks remain blocked. Secrets
stay in transient dialog/native review memory; no React Query/local-storage/SQLite
cache, activity output or clipboard automation. Closing, changing workspaces or
hiding the application clears the dialog; abandoned native reviews are rejected.
Restart app is separate and goes through the ordinary PM2 review. Applications
must actually load that file; frontend/build-time variables need redeployment.

Validation: dotenv parser/round-trip tests; mocked browser paste/conflict/edit/
confirm-save/masking/mobile checks; real disposable loopback OpenSSH SFTP test
covering .env creation, mode 0600, backup, stale revisions and connection mismatch.
No important or client VPS is used. Existing file-editor race/backup tests run
alongside the environment additions in that fixture.

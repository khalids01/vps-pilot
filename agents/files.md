# Remote Files — 2026-10-31

## Implemented

The Files tool uses russh-sftp over a new subsystem channel on the existing,
host-verified authenticated SSH connection. Channels are per explicit operation,
closed afterward, and never install or execute a helper/shell command. First
connected opening loads root once; returning to the workspace does not reload
it or reconnect. Editor, listing and draft stay mounted across navigation.
The file-manager increment below supersedes the earlier explicit-only scope.

CodeMirror provides editing/search/undo and JSON/YAML syntax. Review uses its
bounded unified diff. UTF-8 and consistent LF/CRLF are supported. Native reads
are authoritative; byte fingerprints omit access time and include content,
canonical path, connection, size, owner/group, mode and modification time.
Drafts and proposed writes never enter SQLite, terminal output or activity logs.

## Bounds and permissions

- One file operation per VPS, four across the app. At most four pending reviews
  and 64 MiB of reviewed bytes across the app.
- Text: 1 MiB. Upload/download and existing-file backup: 32 MiB.
- Listing: 1,000 entries, 1,001 response packets; packets at most 256 KiB.
  File transfers use acknowledged 32 KiB chunks. Ten-second request and
  three-minute operation deadlines bound stalled servers.
- Native file dialogs choose local upload/download locations; IPC cannot supply
  arbitrary local filesystem paths.
- Full Unix type bits are checked: symlinks, sockets, FIFOs and devices are never
  treated as regular files. Final file symlinks are rejected.
- Writes protect /etc, /usr, /bin, /sbin, /lib*, /boot, /proc, /sys, /dev, /run,
  /var/lib, /var/log, .ssh and the app's internal backup/staging namespaces.
  Protected files can still be read/downloaded if they are regular and accessible.
- No sudo, chmod UI, permanent deletion, service reload or automatic retry of
  writes. Reviewed bounded recursive operations are described below.
  Other server mutation gates remain disabled.

## Reviewed replacement

Native plans bind profile ID/revision, connection ID, canonical path, original
fingerprint and proposed bytes. Tokens expire in 120 seconds, are single-use and
cleared on disconnect/reject. Buffers are zeroized on drop.

Commit rechecks connection and original content. A new private 700 directory
adjacent to the destination contains a Git-ignore policy, a 600 original backup
when replacing a file, and a private stage. Its ignore policy precedes copying
any content. Stage is created exclusively; owner/group/mode are set before
publication. Optional fsync is used. Content is checked again, then the stage is
atomically renamed over the target using posix-rename@openssh.com, or a
non-overwriting standard rename for a new upload. The result is read back.

This is optimistic conflict checking, not a filesystem lock against arbitrary
external writers. ACLs/xattrs/SELinux labels and special permission bits are not
preserved. Reviews describe this; special mode bits and missing ownership metadata
reject replacement. System config management remains out of scope.

A lost connection/timeout can leave private stages or a completed rename with an
unknown client outcome. Report the error, retain draft/backup location, consume
the review, and require reopening/reviewing rather than retrying automatically.
Never claim rollback occurred or delete the original on an uncertain failure.
Backups are retained; only the known temporary stage/new-file work directory is
cleaned up after a normal success/failure. No automatic backup pruning.

## Validation

The rootless loopback OpenSSH fixture tests actual SFTP listing, text/CRLF,
multi-chunk binary upload/readback, permission preservation, private/Git-ignored
backups, changed-content rejection, symbolic-link rejection, limits, token
single-use and connection invalidation. Run:
`bash tests/fixtures/run-ssh.sh disposable_openssh_sftp`.

Browser bridge tests cover root-once loading, dirty-draft navigation/guards,
review/cancel/save, errors without automatic retry, upload/download controls,
per-server buffers and keeping content out of local persistence/activity output.
Native OS dialog interaction and other SFTP server implementations require
desktop smoke tests. The important user VPS is never a fixture.


## Desktop file manager

List/grid layouts, hidden files by default, path/history/breadcrumb navigation,
filter/sort, checkbox/range/modifier selection and pointer rectangles operate on
the cached listing. Clipboard and folder totals remain memory-only. Folder sizes
are logical regular-file byte sums, not allocated disk usage; symlink targets
are excluded. Totals carry observation times and partial indicators. Scans run
only on explicit size/operation requests, never periodically.

Native operation reviews bind profile revision, connection and tree metadata,
expire in 120 seconds, and are single-use. Up to four reviews, 100 selected
roots, 10,000 tree entries, 20 seconds per scan, and 256 MiB per copy/archive
batch; files remain limited to 32 MiB. Pending tree entries are bounded as well.
Execution has a 15-minute deadline, ten-second individual request limits, one
operation per VPS and four globally. Progress is throttled to 100 ms with final
updates. Cancellation uses a per-operation flag without disconnecting SSH;
remaining nodes/chunks stop, completed operations remain applied.

Copy streams through the desktop into a private Git-ignored stage, preserves
ordinary modes and symlinks without following them, and publishes with a
non-overwriting rename. Backup/staging/trash subtrees are excluded and disclosed.
Moves/renames use standard non-overwriting SFTP rename; cross-filesystem moves
fail without copy-and-delete fallback. Mkdir, paste, move/rename and trash always
require a reviewed target list. Whole selections are checked before the first
mutation; move/trash/restore trees and canonical parents are checked again before
each root operation. Source metadata changes or new destinations stop execution.

Delete renames into a sibling private trash directory's original entry, inside
a mode-700, Git-ignored directory. No permanent delete command or auto-purge
exists. Latest result exposes same-session restore IDs; native records are
bounded to 200 and never evicted to admit more deletes. Original paths must be
absent to restore. Disconnect invalidates restore IDs, but retained copies are
never removed. Cancel/error results list completed roots and retained private
staging paths. Lost responses can leave an uncertain rename outcome: inspect
before retrying.

Rust protects system directories and their ancestors, home roots, credentials,
shell startup files, known database/container data, and private app namespaces.
Move/trash/restore also read bounded Linux mountinfo over SFTP and reject mount
points or their ancestors; unavailable/malformed mount data fails closed.
The guard does not validate arbitrary application dependencies. SFTP remains
optimistic conflict checking, not a lock against external filesystem writers.

Batch download uses a native Save dialog and an uncompressed ZIP in a local
temporary file, published only after completion. It excludes symlinks, rejects
special files, unsafe archive names and duplicate top-level names, and reports
the chosen destination and exclusions before confirmation. No arbitrary local
path is accepted over IPC.

The disposable OpenSSH SFTP test additionally validates recursive copy, modes,
symlink preservation without traversal, ZIP exclusions, single-use plans,
no-overwrite checks, private partial-copy cancellation, trash/restore and rename.
Pure selection tests exercise reverse rectangles, range ordering and modifiers;
browser tests exercise actual pointer selection, protected controls, clipboard
review, folder creation, hidden items, cached navigation, sizes and cancellation.
Native OS dialogs and alternate SFTP servers still need desktop smoke testing.


## Simplified interaction update

Single-click opens folders or supported text files. Checkboxes (revealed on
hover/focus/selection), modifier keys and the rectangle gesture select items
without opening. A compact navigation/search row uses breadcrumbs and an
on-demand address input. Sorting/hidden-file controls live in View options.
Selection actions occupy a stable, horizontally scrollable strip.

A themed Base UI context menu is scoped to the file surface: selected-item
right-click preserves the whole selection, another item replaces it, and empty
space exposes folder actions. The header overflow menu supplies the same actions
without right-click. This does not intercept terminal/editor context behavior.
Per-row download/calculation controls and permission columns are removed.

View details shows cached listing metadata in a right-side panel, with explicit
bounded folder-size calculation. Viewing details hides rather than unmounts an
open editor, preserving drafts and undo state. Panels stack on narrower screens.
Existing native reviews, protection, cancellation and transfer limits remain.

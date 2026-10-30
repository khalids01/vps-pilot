# Local SQLite persistence

Every desktop launch opens `app_config_dir()/vps-pilot.sqlite3` before exposing
the workspace. SQLite is bundled through rusqlite; no external service is used.
The browser-only development preview uses browser storage and does not create
the desktop database.

Schema version 1 uses one `documents(key TEXT PRIMARY KEY, value TEXT NOT NULL)`
table. Values are bounded JSON documents for settings, SSH profiles and host
fingerprints, workspace layout, terminal layout, and a skipped update version.
WAL mode and a two-second busy timeout support short serialized transactions.
No per-second sample is stored. Unix config-directory/database permissions are
700/600; other platforms inherit the user's application-data permissions.

First launch imports validated legacy SSH JSON only if the profile row is absent.
Known legacy browser preferences are sanitized and imported only when absent.
Legacy sources remain unchanged. Existing SQL values always win. Imports are
atomic; profile writes use compare-and-swap to reject stale instances. Newer
schema versions and corrupt files are rejected without replacing the database.

The native API accepts typed settings and allowlisted document keys, never
arbitrary SQL or filesystem paths. The UI has no access to the profiles SQL row
through the document API. Passwords, key contents, terminal output, live metrics,
and command history stay out of the database. A key-file path is profile metadata;
the private-key contents remain in the user's key file. SQLite is not encrypted.

Workspace writes are coalesced for 150ms and serialized; settings and explicit
update-version choices save immediately. The settings page reports saving/errors.
Failed profile/settings saves preserve previously committed data. If bootstrap
fails the UI offers Retry instead of creating replacement defaults. Avoid adding
an ORM, remote sync, metric history, or credentials without a separate request.

## Fleet organization

The allowlisted `vps-pilot:fleet:v1` document stores up to 100 canonical server
IDs with project, tags, environment, favorite and order. Native deserialization
rejects unknown fields, malformed IDs, invalid environments, oversized text,
control characters and out-of-range ordering. This separate document never
changes SSH profile revisions or trusted host fingerprints.

The existing workspace document also remembers fleet/server navigation. Legacy
documents without a page continue restoring the selected server. Fresh desktop
workspaces start at fleet home without opening demonstration tabs.

Fleet health is a bounded in-memory cache of the latest point per profile
revision, filled only by existing open-workspace sampling. It is timestamped
and never persisted to SQLite. Fleet refresh reads local profile/status state;
it does not connect to or inspect a VPS.

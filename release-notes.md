# VPS Pilot 0.2.13

- Add Manage env to project action menus: masked variable editing, add/remove and bulk .env paste with duplicate detection and explicit existing-value replacement.
- Support project .env and named .env files, preserving untouched statements/comments and verifying exact value round trips before saving.
- Require explicit save confirmation, protect against stale files/connections, retain private backups and atomically save with owner-only permissions.
- Keep values out of local storage, saved workflows and logs; close transient env dialogs when the workspace or app becomes inactive.

This edits the remote project file, not PM2’s live environment. Build/restart is separate and the application must load the selected file. Validated with parser/browser tests and a real disposable OpenSSH SFTP fixture. No client VPS was used for testing.

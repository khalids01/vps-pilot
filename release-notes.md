# VPS Pilot 0.2.10

- Add PM2 detection, project status, recent logs and reviewed single/bulk restart. Hide management when PM2 is absent for the connected account.
- Add project action menus, reusable deployment workflows and individual helper commands. Run commands in each project’s PM2 directory, with saved folder overrides for deployments.
- Add editable command lists with drag-and-drop ordering and keyboard controls. Select multiple projects, run a command list, track results and retry failed projects without repeating successful ones.
- Add an SSH connection count in the status header with account, address and port details.

Deployments run as the connected account without automatic sudo. A failed command stops its project while other selected projects continue. Retry reruns the failed workflow from its beginning; no automatic migration retry or Git/database rollback. PM2 online verification does not certify HTTP application health. Real adapter validation covers Debian 12 arm64 with Node 24 and PM2 6.0.14; native WebKit and other environments still need release QA.

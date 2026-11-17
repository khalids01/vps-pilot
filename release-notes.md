# VPS Pilot 0.2.12

- Add Caddy detection and reviewed reload/restart actions to Proxy, with an adapter boundary for future proxy managers.
- Read the active service configuration path, validate as the Caddy account before changing service state, reject stale reviews and verify the result.
- Preserve Caddy configuration, backup files, TLS material and static-site builds. Generic infrastructure-service protections remain enabled.

Currently supports standard active, file-configured systemd Caddy. Custom hooks, overrides, environment-dependent configuration, external imports, API/resume mode and unsafe/unreadable paths remain unsupported. Validated with real Caddy on a disposable Debian 12 arm64 VM; other environments and native WebKit still require release QA. Nginx and Traefik management are not included in this release.

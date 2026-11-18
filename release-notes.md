# VPS Pilot 0.2.17

- Fix screenshot automation for the incoming SSH connection indicator.
- Show PM2 command runs in per-app tabs with live step logs, failure details and retry.
- Manage standard Caddy, Nginx and Traefik system services and Docker proxies from the Proxy page.
- Add configuration editing, templates, diff approval, protected backups and restore for supported file sources.
- Keep the VPS tab bar visible and sharp while dialogs blur only the area below it.

Docker configuration editing requires directory bind mounts. Generated and label-based configuration remains with its owning deployment. Traefik explains its offline validation limits before applying changes.

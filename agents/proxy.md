# Proxy manager adapters

Proxy is an extensible workspace; Caddy is the first native manager adapter.
Rust Manager/Operation enums and the fixed remote adapter define the boundary.
Future Nginx/Traefik support must add its own detection, validation, actions and
integration coverage instead of opening generic service/proxy mutation gates.

Detect reads actual caddy.service configuration, state and config path. Reload
and Restart each create an exact server-bound sudo approval. Preflight captures
service/config evidence, rechecks it before execution, then the privileged worker
rechecks the snapshot under a per-server root-owned flock. Caddy validation runs
as its service account; a failure prevents the service action. Successful reload
must retain the service invocation; restart must create a new active invocation.
No automatic retry, configuration edits or rollback claims. External root changes
remain possible; timeouts/disconnects require inspection before retrying.

Only standard active file-configured systemd Caddy is currently supported. Custom
hooks/dropins/environments, API/resume services, lifecycle dependencies, external
imports and unsafe/unreadable paths show specific unsupported status. Backup
files are never written; unused .save files do not require read access. Caddy
binary/config paths are bound to the review; config contents never leave the
remote adapter. Sudo passwords stay transient in the existing private protocol.

Observed disposable Debian 12 arm64 VM checks: detect as root and fixture account,
reload, restart, static HTTP response/update, invalid-config refusal while the
site keeps serving and Caddyfile.save preservation. Seven local policy tests,
three native adapter tests and a mocked browser approval/detection case supplement
that integration. See tests/fixtures/README.md for setup and remaining coverage.

Upstream semantics: https://caddyserver.com/docs/command-line and
https://caddyserver.com/docs/running . Reload is graceful; static file changes do
not themselves require changing the running configuration. No app health or TLS
correctness claim follows solely from systemd active status.

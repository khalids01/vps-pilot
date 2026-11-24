# Automatic inspection and server tool redesign

Implement automatic inspection for PM2, Proxy, Services, UFW Firewall, Network, and Processes. Give each page a compact, visual workspace that uses the existing VPS Pilot theme. Hide Server Helper. Ship the read-only improvements first, then enable UFW rule changes only after the SSH protection and recovery tests pass.

Read [goal.md](goal.md) first. Use [supported-systems.md](supported-systems.md), [monitoring-validation.md](monitoring-validation.md), and [quick-setup-plan.md](quick-setup-plan.md) for platform, resource, and recovery requirements. Keep VPS Pilot independent from Disk Vacuum. Preserve the existing worktree changes and server workspace state.

## 1. Navigation and automatic loading

- In `src/features/ssh/remote-workspace.tsx`, label the `firewall` tool **UFW Firewall** and remove **Server Helper** from the sidebar. Update the sample workspace, command palette, and user-facing links to match. Keep the `firewall` and `helper` IDs and existing helper code and preferences. If a restored selection points at the hidden helper, land on Overview.
- Start a bounded, read-only inspection when the tool becomes visible on the active, connected VPS. A tool reached from the command palette uses the same page lifecycle. Gate inspection on the workspace and settings visibility and a valid connection. Keep the existing explicit connection flow.
- Load on first visit, on return to a stale snapshot, and when the visible page gets a new connection. Deduplicate in-flight work by tool and server connection. Keep one documented freshness policy for these snapshots unless a tool has a measured reason to differ. Handle rapid navigation and late results without applying a different server or connection's data. Keep connection, terminal, and live sampler lifetimes independent of page navigation.
- Show loading, empty, disconnected, partial, and error states where applicable. Keep the last matching result visible during refresh or failure and label its age or disconnected status. Offer **Refresh** and **Retry** as appropriate. Record automatic reads in the existing command activity UI without opening the console over the page.
- **PM2** already loads on first open and connection changes in `remote-pm2.tsx`. Fix its active-page gating and reuse the account-scoped status reader. Preserve the native daemon-start guard and existing project actions.
- **Proxy** currently loads from **Detect** in `remote-proxy.tsx`. Check the Rust inventory path and reuse its read-only inventory if it can run without approval, or expose a focused read-only entry point. Keep configuration, logs, and lifecycle actions explicit with their existing approvals.
- **Services, Network, and Processes** share `remote-inspection.tsx`. Use the existing bounded Rust commands in `src-tauri/src/ssh/discovery.rs` and structured results. Repair the existing auto-load path so a skipped request during an in-flight inspection can still load once eligible. Use typed fields where a view needs sorting, filtering, or numeric values.
- **UFW Firewall** currently uses `configuration-workspace.tsx` and the shared configuration probe. Give it a dedicated page and a focused UFW read. Leave the broader Quick Setup and SSH Access inspection flow in place. Limit the automatic read to unprivileged commands. When access is insufficient, show **Read UFW status** inline and reuse the existing exact-command sudo approval. Put its result in the same rules view.

## 2. Page layouts

Use shared themed controls and one clear page header. Put the main table or chart first. Use concise status labels with consistent color, green for healthy or allowed, amber for attention, red for failed or blocked, and muted tones for inactive or unavailable. Use distinct, labeled series for charts. Keep badges, focus states, and values readable across supported themes. Move command output and supporting diagnostics into a Details view or the command console. Cover narrow viewports and keyboard interaction with the existing component patterns.

| Page | Main view | Details and actions |
| --- | --- | --- |
| PM2 | App table with state, uptime, restarts, CPU, and memory. Make errors and observed restart increases easy to scan. | Open an app for logs and existing project actions. Preserve selection and deployment behavior across refreshes. |
| Proxy | Show detected Nginx, Caddy, and Traefik instances with status and systemd or Docker ownership. | Open an instance for configuration and logs. Show sites and ports when verified by existing data. |
| Services | Searchable table with separate **Runtime** and **At boot** columns. Filter failed, running, and stopped services. | Keep existing status, logs, and service controls where currently available. |
| Network | Interface names, IP addresses, and link state. Label receive and transmit charts using the existing sampler data. | Search listening ports. Put routes in a secondary view. Keep existing sampler settings and missing-data states. |
| Processes | Sort the bounded snapshot by CPU by default. Show CPU and memory bars with numeric values and sortable columns. Include PID, user, command name, and elapsed time. | Keep arguments and environment out of the inspection payload. |
| UFW Firewall | Status and default policies above a rules table in evaluation order. Include action, direction, port or app, protocol, and source or destination. Let users find a port and identify rules relevant to the observed SSH path. | Put listeners, command output, and Docker/provider firewall context in Details. Use inline context when it affects a decision. |

For UFW, distinguish active, inactive, missing, permission needed, and unavailable. Show refresh time and the server-observed SSH port when known. Distinguish an empty ruleset from partial or unavailable rule data. When UFW is inactive, only display persisted rules if the supported inspection can verify them. Keep IPv4 and IPv6 visible where applicable. Describe what the data says about SSH without claiming public reachability.

## 3. UFW rule changes and SSH protection

Scope the first write release to **Add rule** and **Remove rule**. Use a compact form with HTTP/HTTPS, SSH from a specific IP, and custom port options. Defer enable/disable, default-policy changes, and reordering. Keep the generic firewall mutation gate closed. Any dedicated write path must satisfy the repository's release gates and the disposable VM checks below.

1. **Read the live state.** Use a dedicated native review bound to the exact profile, revision, connection, and current ruleset. Identify the active SSH path using server-observed endpoint addresses, destination port, and address family. Evaluate the proposed ordered rules and defaults. Block changes that could deny the path, including removing its only matching allow rule or inserting a deny ahead of it. Block when the relevant policy, rules, or endpoints cannot be established. Confirmation cannot override a block.
2. **Confirm every change.** Use the shared approval dialog with the target server, exact command, purpose, rule fields, and position when relevant. Reuse the required approval for each app-triggered sudo command. A canceled review makes no change. Build arguments from typed, validated fields in Rust. Keep passwords and sensitive output out of logs and history.
3. **Recheck before applying.** Serialize writes for the target and revalidate the live ruleset, connection identity, and reviewed rule immediately before applying. On drift, require a new review. A row number alone is insufficient as a deletion target.
4. **Arm recovery on the VPS.** Capture the recoverable prior state and confirm that an independent server-side rollback is armed before writing. Reuse existing recovery primitives where suitable. Block if recovery cannot be armed. Make rollback safe around external edits and keep it independent of the app process and the original SSH session.
5. **Verify and save.** Check the resulting rules and establish a fresh, authenticated SSH connection using the same profile, credentials, and destination as the protected session. Use a new transport. Commit the verified change and disarm rollback only after both checks succeed. Refresh the displayed UFW state. On failure, interruption, or lost evidence, leave recovery armed and report rollback as pending until confirmed. Do not replay changes after reconnecting.

## 4. Verification and handoff

- Verify each of the six pages loads on its first visible visit without an Inspect click. Cover inactive VPS tabs, Settings, repeated navigation, reconnect, concurrent Refresh, partial/empty results, and late responses. Confirm the new label and hidden helper entry in remote and sample navigation and in the palette.
- Check sorting, filters, loading states, and layouts with representative data, including narrow windows and keyboard navigation. Confirm Network uses the existing sampler and the read paths keep output, timeouts, and remote overhead bounded.
- Test UFW write behavior only on disposable Debian/Ubuntu VMs covered by the project. Include a nonstandard SSH port, IPv4 and IPv6 where supported, an earlier deny, removing the only matching allow, unsupported or ambiguous policy, canceled confirmation, stale or reordered rules, and concurrent external edits. Verify a safe add and remove persist. Prove recovery with failed fresh authentication, dropped connections, and app exit after apply. Check the rules and a fresh SSH login after rollback. Keep writes gated if recovery remains unverified. Use local fixtures for UI and parser failures and keep the important VPS out of mutation testing.
- Run `bun run check`, `bun run build`, and relevant Rust checks for implementation changes. Run affected unit, browser, and disposable VM tests and report which passed and which are still pending. Record the read-only and write release milestones separately so the UI can land while write verification is pending.

## Implementation status

The read-only workspace now loads all six tools on entry and uses a 30-second
freshness window for automatic reads. The UFW page uses a focused inspection and
shares its rules display with the explicitly approved sudo read.

Add rule, Remove rule, SSH lockout prevention, and server-side rollback still
need implementation and disposable VM verification. The existing mutation gate
continues to protect live servers.

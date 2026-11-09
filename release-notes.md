# VPS Pilot 0.2.9

- Simplify Quick Setup to six steps, combining connection details and removing generic inspection, review and recovery panels. Finish with a compact summary and links to unfinished steps.
- Add working application-stack, developer-tool and runtime installers with official-source/version previews, dependency and conflict checks, per-item results and failed-item retry that skips installed items.
- Add SSH/firewall Apply with staged access changes, independent selected-key login and sudo verification, persistent automatic recovery and retryable local connection saving.
- Preserve existing tools, editor configuration, platform resources, profiles and active SSH sessions; keep passwords and key passphrases transient.

Provisioning requires supported Debian/Ubuntu systems and Python 3. Real installation and SSH recovery coverage is Debian 12 arm64; other accepted OS/CPU combinations and native WebKit still require release validation. LazyVim plugins download on first launch; installing PM2 does not configure boot startup. See agents/supported-systems.md for validation limits.

VPS Pilot 0.2.2

- Test SSH keys against the connected account and port, with planned access shown separately.
- Explain rejected keys and the public-key installation prerequisite without implying server settings were changed.
- Show per-VPS draft saving, saved and retry states; retain failed choices for retry and ignore stale save acknowledgements.
- Restore saved setup choices across navigation and restarts, with independent state for each VPS.
- Clear recovered document-save warnings without hiding unrelated settings errors.

Quick Setup does not yet install public keys, create server accounts, change SSH/UFW settings or install packages. A successful current-account key test does not verify planned access.

macOS downloads include Apple Silicon and Intel installers, ad-hoc signed and not notarized. Windows installers are unsigned.

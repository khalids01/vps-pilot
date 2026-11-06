VPS Pilot 0.2.3

- Install the selected public SSH key for the connected account after reviewing and confirming the destination, fingerprint and backup plan.
- Preserve existing authorized keys and restrictions, keep protected backups, and test key login separately without changing password authentication, ports or firewall settings.
- Reject expired or stale installation reviews and report uncertain interrupted outcomes without automatically retrying.
- Expand the tool sidebar to 256px or collapse it to a 56px icon rail, with saved collapse state, accessible labels and mobile navigation below the headers.
- Keep VPS tabs, stats and terminal sessions in place when toggling the sidebar.
- Show the running app version and clearer current-to-available update details in the sidebar footer.

Public-key installation requires a supported Linux server with Python 3 and uses the connected account's default ~/.ssh/authorized_keys. Custom AuthorizedKeysFile routes are not detected. Broader account creation, SSH/UFW migration and package provisioning remain unavailable.

macOS downloads include Apple Silicon and Intel installers, ad-hoc signed and not notarized. Windows installers are unsigned.

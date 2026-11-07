# VPS Pilot 0.2.4

- Prepare a non-root administrator through the existing root connection, review its public-key installation, and independently verify selected-key SSH and sudo before switching.
- Keep root access available while opening the verified administrator as a separate connected profile. Preserve nonsecret setup choices and progress.
- Improve Fleet card wrapping, organization form spacing and friendly server names in cards and live tabs.

Administrator setup supports Debian 12+ and Ubuntu 22.04+ with Python 3 and standard account/sudo tools already installed. SSH-port, UFW and login-policy migration remain pending; this update does not reboot or disable existing access.

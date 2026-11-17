# VPS Pilot 0.2.11

- Fix SSH command import for `ssh -i ~/.ssh/dev-vps -o IdentitiesOnly=yes dev@host`, including joined and quoted option forms.
- Preserve the selected identity and reject unsupported options or IdentitiesOnly without a configured key. Command import never executes the pasted input.

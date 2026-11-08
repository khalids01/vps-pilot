# VPS Pilot 0.2.7

- Add explicit native configuration scans and preflight reviews to every Quick Setup step, with observed details, scan cancellation and clear retry feedback.
- Save bounded scan/review history per VPS; reopening requires fresh evidence rather than restoring a verification claim.
- Route access changes to existing administrator/key review, apply and verification controls, and explain available recovery limits.

This release adds the workflow foundation. Package installers, SSH/firewall migration and selective undo remain unavailable pending native execution and recovery validation. A scan or preflight does not mark setup complete.

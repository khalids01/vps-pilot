# Appearance themes

Settings → Appearance → Color theme uses an accessible radio-card grid. Each
small SVG preview is generated from the same bundled palette as the app.
Forest Mint stays the default; Tokyo Night, One Dark Pro and GitHub Dark use
adapted upstream dark palettes with brighter semantic colors where necessary.
Sources and full MIT notices are bundled in `public/theme-licenses.txt`.

`src/features/settings/themes.ts` owns the allowlisted IDs, palettes and semantic
CSS variables. AppSettingsProvider applies them in a layout effect before the
workspace paints. Native Settings adds a serde-defaulted enum field inside the
existing SQLite settings document: no schema reset, profile migration or network
work. Missing legacy theme fields deserialize to Forest Mint. Unknown native
IDs fail deserialization. The browser preview persists its selection locally.

Shared components and CodeMirror use CSS variables; syntax highlighting maps
properties/strings/keywords/numbers/comments to the selected palette. Xterm uses
resolved colors and a scoped root-theme observer to refresh its options in
place, including ANSI colors, without replacing SSH sessions or terminal output.
Changing themes does not mount/unmount editors, clear drafts, sample a server or
perform a remote action. Save failures use the existing visible settings error;
the active session may retain the unsaved theme, but restart restores the last
successful database write.

Verification includes contrast checks for semantic text on core surfaces,
control/focus tokens; native legacy-settings and real SQLite reopen tests;
browser selection/reload, keyboard arrows, live xterm color/session preservation,
editor draft retention, and failed-save restoration. These checks do not claim
full native WebKit or whole-application WCAG certification.

## Original VS Code palette correction — 2026-11-01

The user requested closer original colors for Tokyo Night and One Dark Pro and
asked to preserve GitHub Dark. These two themes now use pinned upstream color
snapshots in `src/features/settings/theme-sources/` (repository and revision are
inside each JSON). Workbench button fills, input backgrounds and borders,
sidebar selections, editor selection/cursor, syntax colors and all 16 ANSI
colors have separate roles. No runtime fetch is introduced. Scoped control
styles prevent the old dark-mode input-border tint from replacing real fills.
GitHub Dark and Forest Mint retain their palettes and control rendering.

Source revisions: Tokyo Night `da5546bc4163a02a30d6f3ced90d4ef7dfcb8460`;
One Dark Pro `6f711d1c8d0b57e08beacf1ed6ed22a63e574dcd`. The native app is
not a VS Code renderer: its layout and supported CodeMirror syntax categories
remain app-specific, and upstream roles that are absent require app fallbacks.
One Dark Pro does not specify a button foreground/hover color: use white and its
normal button fill. Focus outlines retain the app's visible accent. Source
colors are no longer silently brightened to pass every contrast assertion;
contrast certification for Forest Mint/GitHub remains separate from fidelity
checks against the two original palettes. Upstream muted/comment/ANSI colors
may have lower contrast. Syntax mapping covers the current editor's categories,
not every TextMate scope or VS Code semantic token rule.

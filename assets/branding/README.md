# VPS Pilot app icon

Source: `vps-pilot-icon-approved.png`, supplied and selected by the user.
The source image is preserved unchanged.

Regenerate platform assets using:

```sh
bun run tauri icon assets/branding/vps-pilot-icon-approved.png --output src-tauri/icons/vps-pilot
```

The desktop bundle uses PNG/ICO/ICNS files in `src-tauri/icons/vps-pilot/`.
Mobile output is unused and can be omitted. Copy the generated 128px PNG to
`public/app-icon.png` for the app header and browser favicon.

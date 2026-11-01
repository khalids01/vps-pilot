import { Check } from "lucide-react";
import { useAppSettings } from "./app-settings";
import { type AppTheme, resolvedThemeVariables, themes } from "./themes";

/** Small app mockup uses the actual palette, including shell, sidebar and code. */
function ThemePreview({ theme }: { theme: AppTheme }) {
  const p = theme.palette;
  const tokens = resolvedThemeVariables(theme);
  return (
    <svg
      viewBox="0 0 280 150"
      className="block w-full rounded-md"
      aria-hidden="true"
    >
      <rect width="280" height="150" rx="6" fill={p.background} />
      <path d="M6 0h268a6 6 0 0 1 6 6v16H0V6a6 6 0 0 1 6-6" fill={p.shell} />
      <circle cx="10" cy="11" r="2" fill={p.red} />
      <circle cx="18" cy="11" r="2" fill={p.yellow} />
      <circle cx="26" cy="11" r="2" fill={p.green} />
      <rect x="40" y="6" width="57" height="12" rx="3" fill={p.card} />
      <text x="46" y="15" fontSize="7" fill={p.foreground}>
        Production
      </text>
      <path d="M0 22h67v128H6a6 6 0 0 1-6-6" fill={p.sidebar} />
      <rect x="5" y="33" width="57" height="15" rx="3" fill={p.accent} />
      <text x="10" y="43" fontSize="7" fill={p.primary}>
        Overview
      </text>
      <text x="10" y="61" fontSize="7" fill={p.muted}>
        Terminal
      </text>
      <text x="10" y="79" fontSize="7" fill={p.muted}>
        Docker
      </text>
      <text x="10" y="97" fontSize="7" fill={p.muted}>
        Firewall
      </text>
      <text x="79" y="39" fontSize="10" fill={p.foreground}>
        Server overview
      </text>
      <rect x="79" y="48" width="87" height="31" rx="3" fill={p.card} />
      <text x="86" y="59" fontSize="7" fill={p.muted}>
        CPU
      </text>
      <text x="86" y="72" fontSize="10" fill={p.primary}>
        12.4%
      </text>
      <rect x="174" y="48" width="94" height="31" rx="3" fill={p.card} />
      <text x="181" y="59" fontSize="7" fill={p.muted}>
        Memory
      </text>
      <text x="181" y="72" fontSize="10" fill={p.foreground}>
        1.2 / 4 GB
      </text>
      <rect
        x="79"
        y="88"
        width="189"
        height="48"
        rx="3"
        fill={tokens["terminal-background"]}
      />
      <g fontFamily="monospace" fontSize="8">
        <text x="86" y="103" fill={p.green}>
          deploy@server ~ $
        </text>
        <text x="86" y="116">
          <tspan fill={p.purple}>const </tspan>
          <tspan fill={p.blue}>status </tspan>
          <tspan fill={p.foreground}>= </tspan>
          <tspan fill={tokens["syntax-string"]}>&quot;healthy&quot;</tspan>
        </text>
        <text x="86" y="129" fill={tokens["terminal-foreground"]}>
          All services running
        </text>
      </g>
    </svg>
  );
}
export function ThemePicker() {
  const { settings, update } = useAppSettings();
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">Color theme</legend>
      <p className="text-sm text-muted-foreground">
        Choose a dark palette for the app, editor and terminals. Your choice is
        saved on this device.
      </p>
      <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 xl:grid-cols-4">
        {themes.map((theme) => (
          <label
            key={theme.id}
            className="relative flex min-w-0 cursor-pointer flex-col rounded-lg border border-border bg-background p-2 has-checked:border-primary has-checked:ring-1 has-checked:ring-primary has-focus-visible:outline-2 has-focus-visible:outline-offset-4 has-focus-visible:outline-ring"
          >
            <input
              type="radio"
              name="color-theme"
              value={theme.id}
              checked={settings.theme === theme.id}
              onChange={() => update({ theme: theme.id })}
              className="absolute inset-0 z-10 size-full cursor-pointer opacity-0"
              aria-label={theme.name}
            />
            <ThemePreview theme={theme} />
            <span className="mt-3 flex items-center justify-between gap-2 px-1 text-sm font-medium">
              {theme.name}
              {settings.theme === theme.id && (
                <Check
                  className="size-4 shrink-0 text-primary"
                  aria-hidden="true"
                />
              )}
            </span>
            <span className="mt-1 mb-1 px-1 text-xs leading-relaxed text-muted-foreground">
              {theme.description}
            </span>
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        VS Code-inspired palettes adapted for VPS Pilot. Preview values are
        illustrative.
      </p>
    </fieldset>
  );
}

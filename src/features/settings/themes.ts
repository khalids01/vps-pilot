import oneDarkPro from "./theme-sources/one-dark-pro.json";
import tokyoNight from "./theme-sources/tokyo-night.json";

/** Palette sources and MIT notices are bundled in /theme-licenses.txt. */
export const themeIds = [
  "forest-mint",
  "tokyo-night",
  "one-dark-pro",
  "github-dark",
] as const;
export type ThemeId = (typeof themeIds)[number];
export const defaultTheme: ThemeId = "forest-mint";
export function isThemeId(value: unknown): value is ThemeId {
  return themeIds.some((id) => id === value);
}
interface Palette {
  background: string;
  foreground: string;
  sidebar: string;
  shell: string;
  card: string;
  control: string;
  accent: string;
  primary: string;
  muted: string;
  border: string;
  input: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  purple: string;
  cyan: string;
}
export interface AppTheme {
  id: ThemeId;
  name: string;
  description: string;
  palette: Palette;
}
export const themes: AppTheme[] = [
  {
    id: "forest-mint",
    name: "Forest Mint",
    description: "VPS Pilot’s forest green and mint.",
    palette: {
      background: "#151b18",
      foreground: "#f0f3f1",
      sidebar: "#101a16",
      shell: "#0b1210",
      card: "#1e2622",
      control: "#28312c",
      accent: "#303d35",
      primary: "#84d9b0",
      muted: "#b1bcb5",
      border: "#3d4841",
      input: "#718077",
      red: "#ff999e",
      green: "#86d6a4",
      yellow: "#f0c779",
      blue: "#82b9f1",
      purple: "#c7a4ed",
      cyan: "#82d6d3",
    },
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    description: "Midnight blue with soft violet accents.",
    palette: {
      background: "#1a1b26",
      foreground: "#a9b1d6",
      sidebar: "#16161e",
      shell: "#16161e",
      card: "#16161e",
      control: "#3b3e52",
      accent: "#202330",
      primary: "#6183bb",
      muted: "#787c99",
      border: "#101014",
      input: "#0f0f14",
      red: "#f7768e",
      green: "#73daca",
      yellow: "#e0af68",
      blue: "#7aa2f7",
      purple: "#bb9af7",
      cyan: "#7dcfff",
    },
  },
  {
    id: "one-dark-pro",
    name: "One Dark Pro",
    description: "Charcoal with familiar blue and warm accents.",
    palette: {
      background: "#282c34",
      foreground: "#abb2bf",
      sidebar: "#21252b",
      shell: "#282c34",
      card: "#21252b",
      control: "#30333d",
      accent: "#2c313a",
      primary: "#61afef",
      muted: "#abb2bf",
      border: "#3e4452",
      input: "#21252b",
      red: "#e06c75",
      green: "#98c379",
      yellow: "#e5c07b",
      blue: "#61afef",
      purple: "#c678dd",
      cyan: "#56b6c2",
    },
  },
  {
    id: "github-dark",
    name: "GitHub Dark",
    description: "Clean neutral surfaces and crisp blue accents.",
    palette: {
      background: "#0d1117",
      foreground: "#e6edf3",
      sidebar: "#010409",
      shell: "#010409",
      card: "#161b22",
      control: "#21262d",
      accent: "#293340",
      primary: "#79c0ff",
      muted: "#b1bac4",
      border: "#3d444d",
      input: "#7d8590",
      red: "#ff9592",
      green: "#7ee787",
      yellow: "#e3b341",
      blue: "#79c0ff",
      purple: "#d2a8ff",
      cyan: "#a5d6ff",
    },
  },
];
export function themeVariables(p: Palette): Record<string, string> {
  return {
    background: p.background,
    foreground: p.foreground,
    card: p.card,
    "card-foreground": p.foreground,
    popover: p.card,
    "popover-foreground": p.foreground,
    primary: p.primary,
    "primary-foreground": p.shell,
    secondary: p.control,
    "secondary-foreground": p.foreground,
    muted: p.control,
    "muted-foreground": p.muted,
    accent: p.accent,
    "accent-foreground": p.foreground,
    destructive: p.red,
    "destructive-foreground": p.shell,
    border: p.border,
    input: p.input,
    ring: p.primary,
    sidebar: p.sidebar,
    "sidebar-foreground": p.foreground,
    "sidebar-accent": p.accent,
    "sidebar-accent-foreground": p.foreground,
    "sidebar-border": p.border,
    "sidebar-ring": p.primary,
    shell: p.shell,
    control: p.control,
    "table-header": p.control,
    "row-hover": p.accent,
    success: p.green,
    warning: p.yellow,
    info: p.muted,
    "syntax-keyword": p.purple,
    "syntax-string": p.green,
    "syntax-number": p.yellow,
    "syntax-property": p.blue,
    "syntax-comment": p.muted,
    "terminal-black": p.shell,
    "terminal-red": p.red,
    "terminal-green": p.green,
    "terminal-yellow": p.yellow,
    "terminal-blue": p.blue,
    "terminal-magenta": p.purple,
    "terminal-cyan": p.cyan,
    "terminal-white": p.foreground,
  };
}
/** Pinned upstream colors; missing VS Code roles use the documented app fallback. */
export function resolvedThemeVariables(
  theme: AppTheme,
): Record<string, string> {
  const variables = themeVariables(theme.palette);
  // Define every extra role for every theme, so switching back never retains overrides.
  Object.assign(variables, {
    "button-background": variables.primary,
    "button-foreground": variables["primary-foreground"],
    "button-hover": variables.primary,
    "input-background": variables.background,
    "input-foreground": variables.foreground,
    "editor-background": variables.background,
    "editor-foreground": variables.foreground,
    "editor-selection": variables.accent,
    "editor-line": variables.muted,
    "editor-cursor": variables.primary,
    "editor-gutter-background": variables.card,
    "editor-gutter-foreground": variables["muted-foreground"],
    "terminal-background": variables.background,
    "terminal-foreground": variables.foreground,
    "terminal-cursor": variables.primary,
    "terminal-selection": variables.accent,
    "terminal-bright-black": variables["muted-foreground"],
  });
  for (const color of [
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
  ]) {
    variables[`terminal-bright-${color}`] = variables[`terminal-${color}`];
  }
  const source =
    theme.id === "tokyo-night"
      ? tokyoNight
      : theme.id === "one-dark-pro"
        ? oneDarkPro
        : null;
  if (!source) return variables;
  const c: Record<string, string> = source.colors;
  Object.assign(variables, {
    "primary-foreground": c["button.foreground"] ?? "#ffffff",
    "button-background": c["button.background"],
    "button-foreground": c["button.foreground"] ?? "#ffffff",
    "button-hover": c["button.hoverBackground"] ?? c["button.background"],
    "secondary-foreground":
      c["button.secondaryForeground"] ??
      c["button.foreground"] ??
      variables.foreground,
    "input-background": c["input.background"],
    "input-foreground": c["input.foreground"],
    "sidebar-foreground": c["sideBar.foreground"],
    "sidebar-accent-foreground": c["list.activeSelectionForeground"],
    "row-hover": c["list.hoverBackground"],
    "editor-background": c["editor.background"],
    "editor-foreground": c["editor.foreground"],
    "editor-selection": c["editor.selectionBackground"],
    "editor-line": c["editor.lineHighlightBackground"],
    "editor-cursor": c["editorCursor.foreground"],
    "editor-gutter-background": c["editor.background"],
    "editor-gutter-foreground":
      c["editorLineNumber.foreground"] ?? variables["muted-foreground"],
    "terminal-background": c["terminal.background"],
    "terminal-foreground": c["terminal.foreground"],
    "terminal-cursor": c["editorCursor.foreground"],
    "terminal-selection": c["terminal.selectionBackground"],
  });
  for (const [role, value] of Object.entries(source.syntax))
    variables[`syntax-${role}`] = value;
  for (const [role, upstream] of Object.entries({
    black: "Black",
    red: "Red",
    green: "Green",
    yellow: "Yellow",
    blue: "Blue",
    magenta: "Magenta",
    cyan: "Cyan",
    white: "White",
  })) {
    variables[`terminal-${role}`] = c[`terminal.ansi${upstream}`];
    variables[`terminal-bright-${role}`] = c[`terminal.ansiBright${upstream}`];
  }
  return variables;
}

export function applyTheme(id: ThemeId) {
  const theme = themes.find((theme) => theme.id === id) ?? themes[0];
  for (const [key, value] of Object.entries(resolvedThemeVariables(theme))) {
    document.documentElement.style.setProperty(`--${key}`, value);
  }
  document.documentElement.dataset.theme = theme.id;
}

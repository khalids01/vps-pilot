import { describe, expect, test } from "bun:test";
import {
  defaultTheme,
  isThemeId,
  resolvedThemeVariables,
  themes,
} from "./themes";

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((index) => {
    const value = hex.slice(index, index + 2);
    const c = Number.parseInt(value, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}
function contrast(a: string, b: string) {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
describe("bundled dark theme accessibility", () => {
  // Exact upstream palettes intentionally retain upstream contrast choices.
  for (const theme of themes.filter(
    (theme) => theme.id === "forest-mint" || theme.id === "github-dark",
  )) {
    test(`${theme.name} keeps text, status and controls legible`, () => {
      const p = theme.palette;
      for (const text of [p.foreground, p.muted, p.red, p.green, p.yellow]) {
        for (const background of [
          p.background,
          p.card,
          p.control,
          p.sidebar,
          p.accent,
        ]) {
          expect(contrast(text, background)).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(contrast(p.primary, p.shell)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.input, p.background)).toBeGreaterThanOrEqual(3);
      expect(contrast(p.primary, p.background)).toBeGreaterThanOrEqual(3);
    });
  }
  test("theme identifiers accept bundled palettes only", () => {
    expect(isThemeId(defaultTheme)).toBe(true);
    expect(isThemeId("unknown")).toBe(false);
    expect(isThemeId(null)).toBe(false);
    expect(isThemeId({ theme: "tokyo-night" })).toBe(false);
  });
});

test("Tokyo Night matches pinned VS Code workbench, syntax and terminal colors", () => {
  const theme = themes.find((theme) => theme.id === "tokyo-night");
  if (!theme) throw Error("Missing Tokyo Night");
  const v = resolvedThemeVariables(theme);
  expect(v.background).toBe("#1a1b26");
  expect(v.foreground).toBe("#a9b1d6");
  expect(v.border).toBe("#101014");
  expect(v["input-background"]).toBe("#14141b");
  expect(v["button-background"]).toBe("#3d59a1dd");
  expect(v["button-foreground"]).toBe("#ffffff");
  expect(v["terminal-background"]).toBe("#16161e");
  expect(v["terminal-foreground"]).toBe("#787c99");
  expect(v["terminal-black"]).toBe("#363b54");
  expect(v["terminal-bright-white"]).toBe("#acb0d0");
  expect(v["syntax-string"]).toBe("#9ece6a");
  expect(v["syntax-number"]).toBe("#ff9e64");
  expect(v["syntax-comment"]).toBe("#51597d");
});

test("One Dark Pro keeps workbench roles separate from its ANSI and syntax palettes", () => {
  const theme = themes.find((theme) => theme.id === "one-dark-pro");
  if (!theme) throw Error("Missing One Dark Pro");
  const v = resolvedThemeVariables(theme);
  expect(v.foreground).toBe("#abb2bf");
  expect(v.shell).toBe("#282c34");
  expect(v["button-background"]).toBe("#404754");
  expect(v["input-background"]).toBe("#1d1f23");
  expect(v["terminal-red"]).toBe("#e05561");
  expect(v["terminal-bright-red"]).toBe("#ff616e");
  expect(v["terminal-blue"]).toBe("#4aa5f0");
  expect(v["terminal-bright-blue"]).toBe("#4dc4ff");
  expect(v["syntax-property"]).toBe("#e06c75");
  expect(v["syntax-number"]).toBe("#d19a66");
  expect(v["syntax-comment"]).toBe("#7f848e");
});

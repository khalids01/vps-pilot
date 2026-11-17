import { parse } from "dotenv";
export class EnvError extends Error {}
export interface EnvEntry {
  id: string;
  key: string;
  value: string;
  raw: string;
  start: number;
  end: number;
}
export interface EnvDocument {
  entries: EnvEntry[];
  duplicates: string[];
  source: string;
}
// Preserve untouched statements/comments. Tokenization adds strict duplicate and
// syntax feedback around dotenv's maintained value parser; nothing is evaluated.
export function parseEnv(source: string): EnvDocument {
  if (source.length > 1024 * 1024 || source.includes("\0"))
    throw new EnvError(
      "Environment text exceeds its limit or contains a null character.",
    );
  const entries: EnvEntry[] = [];
  const duplicates: string[] = [];
  const seen = new Set<string>();
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  for (let i = 0; i < lines.length; i++) {
    const start = offsets[i];
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = line.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
    );
    if (!match) throw new EnvError(`Invalid assignment on line ${i + 1}.`);
    const key = match[1];
    let raw = line;
    const rest = match[2];
    const quote = rest[0];
    if (quote === '"' || quote === "'" || quote === "`") {
      let value = rest.slice(1);
      let closed = false;
      while (true) {
        for (let k = 0; k < value.length; k++) {
          if (value[k] === quote && (k === 0 || value[k - 1] !== "\\")) {
            if (
              value.slice(k + 1).trim() &&
              !value
                .slice(k + 1)
                .trimStart()
                .startsWith("#")
            )
              throw new EnvError(`Unexpected text after ${key}.`);
            closed = true;
            break;
          }
        }
        if (closed) break;
        if (++i >= lines.length)
          throw new EnvError(`Unclosed quoted value for ${key}.`);
        raw += `\n${lines[i]}`;
        value += `\n${lines[i]}`;
      }
    }
    const parsed = parse(raw);
    if (!Object.getOwnPropertyDescriptor(parsed, key))
      throw new EnvError(`Cannot parse ${key}.`);
    if (seen.has(key) && !duplicates.includes(key)) duplicates.push(key);
    seen.add(key);
    entries.push({
      id: crypto.randomUUID(),
      key,
      value: parsed[key],
      raw,
      start,
      end: start + raw.length,
    });
    if (entries.length > 1000)
      throw new EnvError("Maximum 1000 environment variables.");
  }
  return { entries, duplicates, source };
}
export function encodeEnvValue(value: string): string {
  if (!/[\s#'"`\\]/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"') && !value.includes("\\")) return `"${value}"`;
  if (!value.includes("`")) return `\`${value}\``;
  throw new EnvError(
    "This value contains incompatible quote characters. Edit it in Files to preserve its exact syntax.",
  );
}
export function serializeEnv(
  original: EnvDocument,
  entries: EnvEntry[],
): string {
  const keys = new Set<string>();
  for (const entry of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.key))
      throw new EnvError("Use valid variable names.");
    if (keys.has(entry.key))
      throw new EnvError(`Duplicate variable: ${entry.key}`);
    keys.add(entry.key);
  }
  let content = original.source.replace(/\r\n/g, "\n");
  for (const old of [...original.entries].reverse()) {
    const next = entries.find((e) => e.id === old.id);
    const replacement = !next
      ? ""
      : next.key === old.key && next.value === old.value
        ? old.raw
        : `${next.key}=${encodeEnvValue(next.value)}`;
    content =
      content.slice(0, old.start) + replacement + content.slice(old.end);
  }
  for (const entry of entries.filter(
    (e) => !original.entries.some((o) => o.id === e.id),
  )) {
    if (content && !content.endsWith("\n")) content += "\n";
    content += `${entry.key}=${encodeEnvValue(entry.value)}\n`;
  }
  // Round-trip proves that encoded values preserve literal quotes, slashes and newlines.
  const check = parseEnv(content);
  if (
    check.duplicates.length ||
    check.entries.length !== entries.length ||
    entries.some(
      (e) => check.entries.find((c) => c.key === e.key)?.value !== e.value,
    )
  )
    throw new EnvError(
      "Values could not be preserved exactly. Nothing was saved.",
    );
  return original.source.includes("\r\n")
    ? content.replace(/\n/g, "\r\n")
    : content;
}

import { expect, test } from "bun:test";
import { encodeEnvValue, parseEnv, serializeEnv } from "./env-model";

test("dotenv import supports exports, comments, hashes, empty and multiline values without expansion", () => {
  const doc = parseEnv(
    `export API_URL="https://example.test/#a"\nEMPTY=\nTOKEN='\${UNCHANGED}'\nMULTI="line1\nline2"\n# comment\n`,
  );
  expect(doc.entries.map((e) => e.value)).toEqual([
    "https://example.test/#a",
    "",
    `\${UNCHANGED}`,
    "line1\nline2",
  ]);
});
test("duplicates are explicit and malformed text is rejected without echoing values", () => {
  expect(parseEnv("KEY=first\nKEY=second").duplicates).toEqual(["KEY"]);
  for (const text of [
    "not-an-assignment secret",
    'KEY="unclosed-secret',
    'KEY="value" accidental',
  ]) {
    try {
      parseEnv(text);
      throw new Error("accepted");
    } catch (error) {
      expect(String(error)).not.toContain("secret");
    }
  }
});
test("lossless edits use original spans rather than matching comments or substrings", () => {
  const doc = parseEnv('# KEY=old\nKEY=old\nOTHER="KEY=old"\n');
  const next = doc.entries.map((e) =>
    e.key === "KEY" ? { ...e, value: "new value" } : e,
  );
  const text = serializeEnv(doc, next);
  expect(text).toContain("# KEY=old\n");
  expect(parseEnv(text).entries.map((e) => e.value)).toEqual([
    "new value",
    "KEY=old",
  ]);
});
test("duplicate removal and CRLF preservation do not discard unrelated values", () => {
  const doc = parseEnv("# keep\r\nA=one\r\nA=two\r\nB=three\r\n");
  const next = doc.entries.filter((_e, i) => i !== 0);
  const text = serializeEnv(doc, next);
  expect(text).toContain("# keep\r\n");
  expect(parseEnv(text).duplicates).toEqual([]);
  expect(parseEnv(text).entries.map((e) => e.value)).toEqual(["two", "three"]);
});
test("new values round trip spaces, quotes, slashes, newlines and literal expansions", () => {
  for (const value of [
    "",
    "hello world",
    "hash#value",
    'a"b',
    "a'b",
    "C:\\path\\x",
    "line1\nline2",
    `\${TOKEN}`,
  ]) {
    const doc = parseEnv("");
    const raw = `KEY=${encodeEnvValue(value)}`;
    const entry = parseEnv(raw).entries[0];
    expect(parseEnv(serializeEnv(doc, [entry])).entries[0].value).toBe(value);
  }
});

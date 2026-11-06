import { beforeEach, expect, test } from "bun:test";

interface InvokeCall {
  cmd: string;
  args: Record<string, unknown>;
}

type InvokeHandler = (cmd: string, args: Record<string, unknown>) => unknown;

let handler: InvokeHandler = (_cmd, args) => args.value;
let calls: InvokeCall[] = [];

// The real persistence module reads Tauri's globals at call time, so a small
// in-process bridge exercises the same queue/state code as the app and the
// Playwright fixture.
(globalThis as unknown as { isTauri: boolean }).isTauri = true;
(globalThis as unknown as { window: unknown }).window = {
  dispatchEvent: () => true,
  __TAURI_INTERNALS__: {
    invoke: async (cmd: string, args: Record<string, unknown>) => {
      calls.push({ cmd, args });
      return await handler(cmd, args);
    },
  },
};
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  length: 0,
  key: () => null,
  getItem: () => null,
  setItem: () => {},
};

const {
  flushPreferences,
  getPreferenceSaveState,
  hydratePreferences,
  retryPreference,
  writePreference,
} = await import("./persistence");

const key = (suffix: string) => `vps-pilot:test-persistence:${suffix}`;

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("fixture condition was not reached");
}

beforeEach(() => {
  calls = [];
  handler = (_cmd, args) => args.value;
});

test("saved requires the latest matching acknowledgement across keys", async () => {
  const a = key("a-ack");
  const b = key("b-ack");
  let releaseFirstA: (() => void) | undefined;
  let aCalls = 0;
  handler = (_cmd, args) => {
    if (args.key !== a) return args.value;
    aCalls += 1;
    if (aCalls > 1) return args.value;
    return new Promise((resolve) => {
      releaseFirstA = () => resolve(args.value);
    });
  };

  writePreference(a, "a1", { immediate: true });
  expect(getPreferenceSaveState(a).status).toBe("saving");
  writePreference(a, "a2", { immediate: true });
  writePreference(b, "b1", { immediate: true });
  expect(getPreferenceSaveState(a).status).toBe("saving");
  expect(getPreferenceSaveState(b).status).toBe("saving");

  await until(() => releaseFirstA !== undefined);
  releaseFirstA?.();
  await flushPreferences();

  // The older a1 acknowledgement must not mark saved while a2 was queued.
  expect(getPreferenceSaveState(a).status).toBe("saved");
  expect(getPreferenceSaveState(b).status).toBe("saved");
  const acknowledgedA = calls
    .filter((call) => call.args.key === a)
    .map((call) => call.args.value);
  expect(acknowledgedA).toEqual(["a1", "a2"]);
});

test("a later failure stays observable and retries the same latest value", async () => {
  const a = key("a-retry");
  const b = key("b-isolation");
  let releaseFirstA: (() => void) | undefined;
  let aCalls = 0;
  handler = (_cmd, args) => {
    if (args.key !== a) return args.value;
    aCalls += 1;
    if (aCalls === 1) {
      return new Promise((resolve) => {
        releaseFirstA = () => resolve(args.value);
      });
    }
    if (args.value === "a2") throw new Error("fixture document write failed");
    return args.value;
  };

  writePreference(a, "a1", { immediate: true });
  writePreference(a, "a2", { immediate: true });
  writePreference(b, "b1", { immediate: true });
  await until(() => releaseFirstA !== undefined);
  releaseFirstA?.();
  await flushPreferences();

  expect(getPreferenceSaveState(a).status).toBe("error");
  expect(getPreferenceSaveState(b).status).toBe("saved");
  expect(
    calls.filter((call) => call.args.key === a && call.args.value === "a2"),
  ).toHaveLength(1);

  handler = (_cmd, args) => args.value;
  await retryPreference(a);
  expect(getPreferenceSaveState(a).status).toBe("saved");
  expect(getPreferenceSaveState(b).status).toBe("saved");
  const retried = calls.filter(
    (call) => call.args.key === a && call.args.value === "a2",
  );
  // The identical cached value is retried, not skipped.
  expect(retried).toHaveLength(2);
});

test("failed writes return with the latest value on retry", async () => {
  const a = key("a-latest");
  let fail = true;
  handler = (_cmd, args) => {
    if (fail) throw new Error("fixture document write failed");
    return args.value;
  };
  writePreference(a, "first", { immediate: true });
  await flushPreferences();
  expect(getPreferenceSaveState(a).status).toBe("error");
  writePreference(a, "second", { immediate: true });
  await flushPreferences();
  expect(getPreferenceSaveState(a).status).toBe("error");
  fail = false;
  await retryPreference(a);
  expect(getPreferenceSaveState(a).status).toBe("saved");
  const values = calls
    .filter((call) => call.args.key === a)
    .map((call) => call.args.value);
  expect(values[values.length - 1]).toBe("second");
});

test("hydrated acknowledged documents start saved", async () => {
  const draftKey =
    "vps-pilot:quick-setup-draft:v1:33333333-3333-4333-8333-333333333333";
  const draft = {
    version: 1,
    step: 4,
    administrator: { mode: "new", username: "deploy" },
    sshKey: {
      strategy: "generate",
      generatedKeyId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    },
    access: {
      port: 52022,
      ufw: "configure",
      recoveryAcknowledged: false,
      allowHttp: false,
      allowHttps: false,
      rules: [],
    },
    stack: { choice: "skip", engine: null },
    tools: { editor: "none", utilities: ["git", "curl", "unzip"] },
    runtimes: [],
  };
  await hydratePreferences({ [draftKey]: JSON.stringify(draft) });
  expect(getPreferenceSaveState(draftKey).status).toBe("saved");
});

test("non-Tauri localStorage failures keep an error and retry the latest value", async () => {
  const k = key("local");
  const store = new Map<string, string>();
  const originalTauri = (globalThis as unknown as { isTauri: boolean }).isTauri;
  const originalLocalStorage = (
    globalThis as unknown as { localStorage: unknown }
  ).localStorage;
  let fail = true;
  (globalThis as unknown as { isTauri: boolean }).isTauri = false;
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    length: 0,
    key: () => null,
    getItem: (name: string) => store.get(name) ?? null,
    setItem: (name: string, value: string) => {
      if (fail) throw new Error("fixture localStorage failure");
      store.set(name, value);
    },
  };
  try {
    writePreference(k, "local-latest");
    expect(getPreferenceSaveState(k).status).toBe("error");
    fail = false;
    await retryPreference(k);
    expect(getPreferenceSaveState(k).status).toBe("saved");
    expect(store.get(k)).toBe("local-latest");
  } finally {
    (globalThis as unknown as { isTauri: boolean }).isTauri = originalTauri;
    (globalThis as unknown as { localStorage: unknown }).localStorage =
      originalLocalStorage;
  }
});

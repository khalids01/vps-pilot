import { expect, test } from "bun:test";
import {
  quickSetupCatalog,
  quickSetupHerdr,
  quickSetupSourcePolicy,
} from "./quick-setup-catalog";
import {
  defaultQuickSetupDraft,
  parseQuickSetupPort,
  type QuickSetupDraft,
  quickSetupDraftKey,
  quickSetupDraftPrefix,
  resolveQuickSetupPlan,
  sanitizeQuickSetupDraft,
  validateQuickSetupPort,
  validateQuickSetupUsername,
} from "./quick-setup-model";

const server = "11111111-1111-4111-8111-111111111111";

function clone(): QuickSetupDraft {
  return JSON.parse(JSON.stringify(defaultQuickSetupDraft()));
}

function requireDraft(value: unknown): QuickSetupDraft {
  const draft = sanitizeQuickSetupDraft(value);
  if (!draft) throw Error("Expected a valid Quick Setup draft.");
  return draft;
}

test("quick setup draft keys require a real server UUID", () => {
  expect(quickSetupDraftKey(server)).toBe(`${quickSetupDraftPrefix}${server}`);
  expect(quickSetupDraftKey("not-a-uuid")).toBeNull();
  expect(quickSetupDraftKey("11111111-1111-4111-8111")).toBeNull();
  expect(quickSetupDraftKey("")).toBeNull();
});

test("quick setup sanitizer accepts only typed, validated draft choices", () => {
  const draft = clone();
  expect(draft.access.port).toBe(52022);
  expect(sanitizeQuickSetupDraft(draft)).toEqual(draft);
  expect(validateQuickSetupUsername("deploy")).toBeNull();
  expect(validateQuickSetupUsername("ops_2")).toBeNull();
  expect(validateQuickSetupPort(1)).toBeNull();
  expect(validateQuickSetupPort(65535)).toBeNull();
  expect(parseQuickSetupPort("2222")).toBe(2222);
  expect(parseQuickSetupPort(" 22 ")).toBe(22);

  for (const value of [
    { ...clone(), stack: { choice: "dokploy", engine: "docker" } },
    {
      ...clone(),
      stack: { choice: "javascript", engine: null },
      runtimes: ["nvm-node"],
    },
    {
      ...clone(),
      stack: { choice: "javascript", engine: "docker" },
      runtimes: ["nvm-node"],
    },
    { ...clone(), stack: { choice: "containers", engine: "podman" } },
    { ...clone(), stack: { choice: "skip", engine: null } },
  ] as const)
    expect(sanitizeQuickSetupDraft(value)).not.toBeNull();
});

test("generated key references are optional, opaque and strategy-bound", () => {
  const generatedKeyId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const withKey = requireDraft({
    ...clone(),
    sshKey: { strategy: "generate", generatedKeyId },
  });
  expect(withKey.sshKey).toEqual({ strategy: "generate", generatedKeyId });
  expect(sanitizeQuickSetupDraft(clone())?.sshKey).toEqual({
    strategy: "existing",
  });
  const withoutKey = requireDraft({
    ...clone(),
    sshKey: { strategy: "generate" },
  });
  expect(withoutKey.sshKey).toEqual({ strategy: "generate" });

  for (const value of [
    { strategy: "generate", generatedKeyId: null },
    { strategy: "existing", generatedKeyId: null },
    { strategy: "generate", generatedKeyId: "not-a-uuid" },
    { strategy: "generate", generatedKeyId: generatedKeyId.toUpperCase() },
    { strategy: "generate", generatedKeyId: `${generatedKeyId}/../escape` },
    { strategy: "existing", generatedKeyId },
    { strategy: "agent", generatedKeyId },
    { strategy: "generate", generatedKeyId, path: "/tmp/key" },
    { strategy: "generate", generatedKeyId, passphrase: "never persist" },
  ])
    expect(sanitizeQuickSetupDraft({ ...clone(), sshKey: value })).toBeNull();
});

test("quick setup sanitizer rejects unknown versions, fields and secrets", () => {
  const rejected: unknown[] = [
    null,
    [],
    "draft",
    { ...clone(), version: 2 },
    { ...clone(), version: 1.5 },
    { ...clone(), step: 0 },
    { ...clone(), step: 9 },
    { ...clone(), step: 2.5 },
    { ...clone(), password: "never persist" },
    { ...clone(), administrator: { ...clone().administrator, secret: "no" } },
    { ...clone(), sshKey: { ...clone().sshKey, passphrase: "no" } },
    { ...clone(), access: { ...clone().access, approval: true } },
    { ...clone(), stack: { ...clone().stack, command: "no" } },
    { ...clone(), tools: { ...clone().tools, output: "no" } },
    { ...clone(), runtimes: [{ id: "bun" }] },
  ];
  for (const value of rejected)
    expect(sanitizeQuickSetupDraft(value)).toBeNull();
});

test("quick setup sanitizer rejects invalid enums, usernames and ports", () => {
  const cases: QuickSetupDraft[] = [];
  for (const username of [
    "",
    "root",
    "Root",
    "-ops",
    "deploy user",
    "a".repeat(33),
  ]) {
    cases.push({
      ...clone(),
      administrator: { ...clone().administrator, username },
    });
  }
  for (const port of [0, -1, 65536, 22.5]) {
    cases.push({ ...clone(), access: { ...clone().access, port } });
  }
  cases.push({
    ...clone(),
    administrator: { ...clone().administrator, mode: "root" as never },
  });
  cases.push({ ...clone(), sshKey: { strategy: "copy" as never } });
  cases.push({
    ...clone(),
    access: { ...clone().access, ufw: "open" as never },
  });
  cases.push({
    ...clone(),
    access: { ...clone().access, recoveryAcknowledged: "yes" as never },
  });
  cases.push({
    ...clone(),
    stack: { choice: "kubernetes" as never, engine: null },
  });
  cases.push({ ...clone(), stack: { choice: "dokploy", engine: "podman" } });
  cases.push({ ...clone(), stack: { choice: "dokploy", engine: null } });
  cases.push({ ...clone(), stack: { choice: "skip", engine: "docker" } });
  cases.push({
    ...clone(),
    stack: { choice: "containers", engine: "lxc" as never },
  });
  cases.push({
    ...clone(),
    tools: { ...clone().tools, editor: "vscode" as never },
  });
  for (const value of cases) expect(sanitizeQuickSetupDraft(value)).toBeNull();
  for (const value of ["", "root", "Deploy", "deploy user", "a".repeat(33)])
    expect(validateQuickSetupUsername(value)).not.toBeNull();
  for (const value of [0, -1, 65536, 2.5, Number.NaN])
    expect(validateQuickSetupPort(value)).not.toBeNull();
  expect(parseQuickSetupPort("70000")).toBeNull();
  expect(parseQuickSetupPort("abc")).toBeNull();
});

test("quick setup sanitizer rejects duplicate and unknown catalog IDs", () => {
  const cases: QuickSetupDraft[] = [
    { ...clone(), tools: { ...clone().tools, utilities: ["git", "git"] } },
    {
      ...clone(),
      tools: { ...clone().tools, utilities: ["tmux" as never] },
    },
    {
      ...clone(),
      tools: {
        ...clone().tools,
        utilities: [
          "git",
          "curl",
          "ripgrep",
          "fd",
          "fzf",
          "jq",
          "btop",
          "unzip",
          "jq",
        ] as never,
      },
    },
    { ...clone(), runtimes: ["bun", "bun"] },
    { ...clone(), runtimes: ["deno" as never] },
    { ...clone(), runtimes: ["bun", "nvm-node", "uv", "bun"] as never },
  ];
  for (const value of cases) expect(sanitizeQuickSetupDraft(value)).toBeNull();
});

test("every stack choice requires an explicit engine key", () => {
  for (const choice of ["dokploy", "javascript", "containers", "skip"]) {
    const value = {
      ...clone(),
      stack: { choice },
      runtimes: choice === "javascript" ? ["nvm-node"] : [],
    };
    expect(sanitizeQuickSetupDraft(value)).toBeNull();
  }
});

test("Herdr is an optional draft tool while installer verification is pending", () => {
  expect(
    sanitizeQuickSetupDraft({
      ...clone(),
      tools: { ...clone().tools, utilities: ["herdr"] },
    }),
  ).not.toBeNull();
  expect(quickSetupCatalog.herdr.label).toBe("Herdr");
  expect(quickSetupCatalog.herdr.executable).toBe(false);
});

test("JavaScript / PM2 requires NVM + Node.js and cannot drop it", () => {
  const required = requireDraft({
    ...clone(),
    stack: { choice: "javascript", engine: null },
    runtimes: ["nvm-node"],
  });
  expect(required.runtimes).toContain("nvm-node");
  expect(
    sanitizeQuickSetupDraft({
      ...clone(),
      stack: { choice: "javascript", engine: null },
      runtimes: ["bun", "uv"],
    }),
  ).toBeNull();
  const optional = requireDraft({
    ...clone(),
    stack: { choice: "skip", engine: null },
    runtimes: ["nvm-node", "bun", "uv"],
  });
  expect(optional.runtimes).toEqual(["nvm-node", "bun", "uv"]);
});

test("quick setup resolver deduplicates stack and selected dependencies", () => {
  const emptyPlan = resolveQuickSetupPlan(clone());
  expect(emptyPlan.missing).toEqual([]);
  expect(emptyPlan.duplicateSelections).toBe(0);
  expect(emptyPlan.items.map((item) => item.id)).toEqual([
    "git",
    "curl",
    "unzip",
  ]);

  const combined = requireDraft({
    ...clone(),
    stack: { choice: "javascript", engine: "docker" },
    tools: { editor: "lazyvim", utilities: ["git"] },
    runtimes: ["nvm-node", "bun"],
  });
  const plan = resolveQuickSetupPlan(combined);
  expect(plan.duplicateSelections).toBe(2);
  expect(plan.missing).toEqual([]);
  expect(plan.items.map((item) => item.id)).toEqual([
    "javascript-pm2",
    "nvm-node",
    "docker",
    "neovim",
    "lazyvim-starter",
    "git",
    "ripgrep",
    "fd",
    "bun",
  ]);
  expect(plan.items.filter((item) => item.id === "nvm-node")).toHaveLength(1);

  const dokploy = requireDraft({
    ...clone(),
    stack: { choice: "dokploy", engine: "docker" },
  });
  const dokployPlan = resolveQuickSetupPlan(dokploy);
  expect(dokployPlan.duplicateSelections).toBe(0);
  expect(dokployPlan.items.map((item) => item.id)).toContain("docker");
  expect(dokployPlan.items.filter((item) => item.id === "docker")).toHaveLength(
    1,
  );

  const containers = requireDraft({
    ...clone(),
    stack: { choice: "containers", engine: null },
  });
  expect(resolveQuickSetupPlan(containers).missing).toEqual([
    "Container foundation needs Docker or Podman.",
  ]);
});

test("catalog metadata is clearly non-executable and source-policy only", () => {
  for (const entry of Object.values(quickSetupCatalog)) {
    expect(entry.executable).toBe(false);
    expect(entry.sourceStatus).toBe("policy-only");
    expect(entry.description.length).toBeGreaterThan(0);
  }
  expect(quickSetupHerdr.installer).toBe("pending-verification");
  expect(quickSetupHerdr.reason).toContain("installer");
  expect(quickSetupCatalog.neovim.description).toContain(
    "Latest compatible stable official Neovim",
  );
  expect(quickSetupSourcePolicy).toContain("must be rechecked");
  expect(quickSetupSourcePolicy).toContain("not a verified");
  expect(quickSetupSourcePolicy).not.toContain("https://");
});

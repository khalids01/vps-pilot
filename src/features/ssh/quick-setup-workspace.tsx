import { Check } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { ConfigurationNotice } from "@/components/configuration-status";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import type { ServerProfile } from "./api";
import {
  quickSetupCatalog,
  quickSetupCatalogLabel,
  quickSetupHerdr,
  quickSetupSourcePolicy,
} from "./quick-setup-catalog";
import { QuickSetupKeyManager } from "./quick-setup-keys";
import {
  defaultQuickSetupDraft,
  parseQuickSetupPort,
  type QuickSetupAdminMode,
  type QuickSetupDraft,
  type QuickSetupEditorChoice,
  type QuickSetupKeyStrategy,
  type QuickSetupRuntimeId,
  type QuickSetupStackChoice,
  type QuickSetupStepId,
  type QuickSetupUfwChoice,
  type QuickSetupUtilityId,
  quickSetupDraftKey,
  quickSetupRuntimes,
  quickSetupSteps,
  quickSetupUtilities,
  readQuickSetupDraft,
  requiredQuickSetupRuntimes,
  resolveQuickSetupPlan,
  sanitizeQuickSetupDraft,
  validateQuickSetupUsername,
  writeQuickSetupDraft,
} from "./quick-setup-model";

const adminModeLabels: Record<QuickSetupAdminMode, string> = {
  new: "Create a new administrator",
  existing: "Use an existing administrator",
};
const keyStrategyLabels: Record<QuickSetupKeyStrategy, string> = {
  existing: "Use an existing key",
  generate: "Generate a new key",
  agent: "Use the SSH agent",
};
const keyStrategyDescriptions: Record<QuickSetupKeyStrategy, string> = {
  existing: "Reference a protected local key file; no key material is copied.",
  generate:
    "Create an encrypted Ed25519 key in this app's local key vault. Creating it does not install it on a server or verify login.",
  agent:
    "Use a key available through the local SSH agent. Agent keys may not be exportable.",
};
const ufwLabels: Record<QuickSetupUfwChoice, string> = {
  configure: "Configure a restrictive UFW plan",
  "keep-current": "Keep the current firewall",
};
const stackLabels: Record<QuickSetupStackChoice, string> = {
  dokploy: "Dokploy",
  javascript: "JavaScript / PM2",
  containers: "Container foundation",
  skip: "Skip application stack",
};
const stackDescriptions: Record<QuickSetupStackChoice, string> = {
  dokploy:
    "Docker-based application platform with a guided substep review. Docker is required.",
  javascript: "Node.js through NVM, PM2 and optional Bun or container tooling.",
  containers:
    "Docker or Podman foundation only. Application-language provisioning is not included.",
  skip: "Complete the secure base access plan without an application platform.",
};
const editorLabels: Record<QuickSetupEditorChoice, string> = {
  none: "Plain terminal editing",
  neovim: "Neovim",
  lazyvim: "Neovim + LazyVim",
};
const editorDescriptions: Record<QuickSetupEditorChoice, string> = {
  none: "No editor is planned.",
  neovim:
    "Latest compatible stable official Neovim release, with sudoedit for privileged files.",
  lazyvim:
    "Latest compatible stable official Neovim release plus the official LazyVim starter at a recorded revision.",
};

function keySelectionSummary(draft: QuickSetupDraft) {
  if (draft.sshKey.strategy === "generate" && draft.sshKey.generatedKeyId)
    return "Encrypted key selected locally · not installed or verified";
  return keyStrategyLabels[draft.sshKey.strategy];
}

function QuickSetupHeader({
  profile,
  connected,
}: {
  profile: ServerProfile;
  connected: boolean;
}) {
  return (
    <header className="flex min-w-0 flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 max-w-3xl">
        <h1 className="text-xl font-semibold tracking-tight">Quick Setup</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Prepare secure access, application stacks and tools for this VPS.
        </p>
      </div>
      <div className="min-w-0 text-xs leading-relaxed text-muted-foreground sm:text-right">
        <p className="break-all font-medium text-foreground">{profile.name}</p>
        <p className="break-all">
          {profile.username}@{profile.host}:{profile.port}
        </p>
        <p>{connected ? "Connected profile" : "Disconnected profile"}</p>
      </div>
    </header>
  );
}

function StepStatus() {
  return (
    <span className="rounded-full border border-warning/40 px-2 py-0.5 text-[10px] text-warning">
      Planned · unverified
    </span>
  );
}

function StepSection({
  step,
  title,
  children,
}: {
  step: QuickSetupStepId;
  title: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`quick-setup-step-${step}`} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`quick-setup-step-${step}`} className="text-base font-medium">
          {title}
        </h2>
        <StepStatus />
      </div>
      {children}
    </section>
  );
}

function ChoiceButton({
  selected,
  onClick,
  description,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant={selected ? "secondary" : "outline"}
      aria-pressed={selected}
      onClick={onClick}
      className="h-auto min-h-12 w-full justify-start whitespace-normal text-left aria-pressed:border-primary aria-pressed:ring-1 aria-pressed:ring-primary/40"
    >
      <span className="flex min-w-0 flex-col gap-1">
        <span className="font-medium">{children}</span>
        {description && (
          <span className="text-xs font-normal text-muted-foreground">
            {description}
          </span>
        )}
      </span>
      {selected && (
        <Check aria-hidden="true" className="ml-auto size-4 text-primary" />
      )}
    </Button>
  );
}

function TechnicalDetails() {
  return (
    <details className="rounded-lg border p-3 text-xs">
      <summary className="cursor-pointer text-muted-foreground">
        Technical details
      </summary>
      <p className="mt-2 leading-relaxed text-muted-foreground">
        {quickSetupSourcePolicy}
      </p>
    </details>
  );
}

function SummaryCard({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-lg border p-4">
      <h3 className="text-sm font-medium">{title}</h3>
      <div className="mt-2 min-w-0 text-sm text-muted-foreground">
        {children}
      </div>
    </section>
  );
}

export function QuickSetupWorkspace({
  profile,
  connected,
  onOpenInspection,
}: {
  profile: ServerProfile;
  connected: boolean;
  onOpenInspection: () => void;
}) {
  const [initial] = useState(() => {
    const loaded = readQuickSetupDraft(profile.id);
    return {
      loaded,
      draft: loaded.status === "ok" ? loaded.draft : defaultQuickSetupDraft(),
      invalid: loaded.status === "invalid",
    };
  });
  const [draft, setDraft] = useState<QuickSetupDraft | null>(
    initial.invalid ? null : initial.draft,
  );
  const [invalid, setInvalid] = useState(initial.invalid);
  const [saved, setSaved] = useState(initial.loaded.status === "ok");
  const [usernameText, setUsernameText] = useState(
    initial.draft.administrator.username,
  );
  const [portText, setPortText] = useState(String(initial.draft.access.port));
  const page = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    page.current?.closest("main")?.scrollTo({ top: 0 });
  }, []);

  function commit(next: QuickSetupDraft) {
    const clean = sanitizeQuickSetupDraft(next);
    if (!clean) return;
    setDraft(clean);
    setInvalid(false);
    setSaved(true);
    writeQuickSetupDraft(profile.id, clean);
  }
  function update(mutate: (current: QuickSetupDraft) => QuickSetupDraft) {
    if (draft) commit(mutate(draft));
  }
  function changeStep(step: QuickSetupStepId) {
    if (!draft) return;
    commit({ ...draft, step });
    setUsernameText(draft.administrator.username);
    setPortText(String(draft.access.port));
    page.current?.closest("main")?.scrollTo({ top: 0 });
  }
  function resetDraft() {
    const next = defaultQuickSetupDraft();
    setDraft(next);
    setUsernameText(next.administrator.username);
    setPortText(String(next.access.port));
    setInvalid(false);
    setSaved(true);
    writeQuickSetupDraft(profile.id, next);
  }
  function chooseStack(choice: QuickSetupStackChoice) {
    update((current) => ({
      ...current,
      stack: {
        choice,
        engine:
          choice === "dokploy"
            ? "docker"
            : choice === "skip"
              ? null
              : current.stack.engine,
      },
      runtimes:
        choice === "javascript" && !current.runtimes.includes("nvm-node")
          ? [...current.runtimes, "nvm-node"]
          : current.runtimes,
    }));
  }
  function toggleUtility(id: QuickSetupUtilityId) {
    update((current) => ({
      ...current,
      tools: {
        ...current.tools,
        utilities: current.tools.utilities.includes(id)
          ? current.tools.utilities.filter((value) => value !== id)
          : [...current.tools.utilities, id],
      },
    }));
  }
  function toggleRuntime(id: QuickSetupRuntimeId) {
    if (!draft || requiredQuickSetupRuntimes(draft).includes(id)) return;
    update((current) => ({
      ...current,
      runtimes: current.runtimes.includes(id)
        ? current.runtimes.filter((value) => value !== id)
        : [...current.runtimes, id],
    }));
  }

  if (invalid || !draft) {
    return (
      <section ref={page} aria-label="Quick Setup" className="space-y-6">
        <QuickSetupHeader profile={profile} connected={connected} />
        <ConfigurationNotice title="Saved draft cannot be used">
          The saved preview for this server is corrupt or from a newer version.
          It has not been replaced. Reset it to start from defaults.
        </ConfigurationNotice>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={resetDraft}>
            Reset draft
          </Button>
          <p className="text-xs text-muted-foreground">
            Nothing changes until you choose Reset draft.
          </p>
        </div>
      </section>
    );
  }

  const usernameError = validateQuickSetupUsername(usernameText);
  const portError =
    parseQuickSetupPort(portText) === null
      ? "Use a whole port from 1 to 65535."
      : null;
  const plan = resolveQuickSetupPlan(draft);
  const requiredRuntimes = requiredQuickSetupRuntimes(draft);
  const forwardBlocked = Boolean(usernameError || portError);
  const noDraftStorage = quickSetupDraftKey(profile.id) === null;

  let stepContent: ReactNode;
  if (draft.step === 1) {
    stepContent = (
      <StepSection step={1} title="Connect and inspect">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Review the saved profile, then open the existing inspection view when
          you are ready. Nothing connects automatically.
        </p>
        <dl className="grid gap-3 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
          <dt className="text-muted-foreground">Profile</dt>
          <dd className="break-all">{profile.name}</dd>
          <dt className="text-muted-foreground">Address</dt>
          <dd className="break-all">
            {profile.username}@{profile.host}:{profile.port}
          </dd>
          <dt className="text-muted-foreground">Connection</dt>
          <dd>{connected ? "Connected" : "Disconnected"}</dd>
          <dt className="text-muted-foreground">Saved key</dt>
          <dd className="break-all">
            {profile.identityFile || "SSH agent / default keys"}
          </dd>
        </dl>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" onClick={onOpenInspection}>
            Open server inspection
          </Button>
          <p className="text-xs text-muted-foreground">
            Nothing is inspected or connected automatically.
          </p>
        </div>
      </StepSection>
    );
  } else if (draft.step === 2) {
    stepContent = (
      <StepSection step={2} title="Administrator">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Choose a separate administrator or an existing account. Sudo access is
          not verified.
        </p>
        <fieldset
          aria-label="Administrator choice"
          className="grid min-w-0 gap-2 sm:grid-cols-2"
        >
          {(["new", "existing"] as const).map((mode) => (
            <ChoiceButton
              key={mode}
              selected={draft.administrator.mode === mode}
              onClick={() =>
                update((current) => ({
                  ...current,
                  administrator: { ...current.administrator, mode },
                }))
              }
              description={
                mode === "new"
                  ? "A separate sudo-capable account."
                  : "An existing account with unknown privileges."
              }
            >
              {adminModeLabels[mode]}
            </ChoiceButton>
          ))}
        </fieldset>
        <label htmlFor="quick-setup-username" className="block text-sm">
          Administrator username
          <Input
            id="quick-setup-username"
            className="mt-2"
            value={usernameText}
            maxLength={32}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={Boolean(usernameError)}
            aria-describedby={
              usernameError ? "quick-setup-username-error" : undefined
            }
            onChange={(event) => {
              const value = event.target.value;
              setUsernameText(value);
              if (validateQuickSetupUsername(value) === null)
                update((current) => ({
                  ...current,
                  administrator: {
                    ...current.administrator,
                    username: value,
                  },
                }));
            }}
          />
        </label>
        {usernameError && (
          <p
            id="quick-setup-username-error"
            role="alert"
            className="text-xs text-destructive"
          >
            {usernameError}
          </p>
        )}
        <p className="text-xs leading-relaxed text-muted-foreground">
          The draft keeps the last valid username while the field is invalid.
        </p>
      </StepSection>
    );
  } else if (draft.step === 3) {
    stepContent = (
      <StepSection step={3} title="SSH key">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Choose a key strategy. Generated keys are created and encrypted
          locally; installing a public key and verifying login remain
          unavailable.
        </p>
        <fieldset aria-label="SSH key strategy" className="grid min-w-0 gap-2">
          {(["existing", "generate", "agent"] as const).map((strategy) => (
            <ChoiceButton
              key={strategy}
              selected={draft.sshKey.strategy === strategy}
              onClick={() =>
                update((current) => ({
                  ...current,
                  sshKey:
                    strategy === "generate"
                      ? {
                          strategy,
                          ...(current.sshKey.strategy === "generate" &&
                          current.sshKey.generatedKeyId
                            ? { generatedKeyId: current.sshKey.generatedKeyId }
                            : {}),
                        }
                      : { strategy },
                }))
              }
              description={keyStrategyDescriptions[strategy]}
            >
              {keyStrategyLabels[strategy]}
            </ChoiceButton>
          ))}
        </fieldset>
        {draft.sshKey.strategy === "generate" ? (
          <QuickSetupKeyManager
            selectedKeyId={draft.sshKey.generatedKeyId}
            onSelectKey={(keyId) =>
              update((current) => ({
                ...current,
                sshKey: { strategy: "generate", generatedKeyId: keyId },
              }))
            }
          />
        ) : (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Private-key contents are never entered here. Passphrases are entered
            only in the local key creation form and are never saved.
          </p>
        )}
      </StepSection>
    );
  } else if (draft.step === 4) {
    stepContent = (
      <StepSection step={4} title="SSH and firewall">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Choose the target port and firewall preference. Neither choice proves
          server, provider or recovery readiness.
        </p>
        <label htmlFor="quick-setup-port" className="block text-sm">
          Target SSH port
          <Input
            id="quick-setup-port"
            className="mt-2 max-w-40"
            inputMode="numeric"
            value={portText}
            maxLength={5}
            autoComplete="off"
            aria-invalid={Boolean(portError)}
            aria-describedby={portError ? "quick-setup-port-error" : undefined}
            onChange={(event) => {
              const value = event.target.value;
              setPortText(value);
              const port = parseQuickSetupPort(value);
              if (port !== null)
                update((current) => ({
                  ...current,
                  access: { ...current.access, port },
                }));
            }}
          />
        </label>
        {portError && (
          <p
            id="quick-setup-port-error"
            role="alert"
            className="text-xs text-destructive"
          >
            {portError}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          High ports such as 52,022 are suggestions only. Check collisions and
          ephemeral ranges on the server. The draft keeps the last valid port.
        </p>
        <fieldset
          aria-label="Firewall choice"
          className="grid min-w-0 gap-2 sm:grid-cols-2"
        >
          {(["configure", "keep-current"] as const).map((choice) => (
            <ChoiceButton
              key={choice}
              selected={draft.access.ufw === choice}
              onClick={() =>
                update((current) => ({
                  ...current,
                  access: { ...current.access, ufw: choice },
                }))
              }
              description={
                choice === "configure"
                  ? "Plan an allow rule before restrictive policy."
                  : "Make no UFW plan; provider rules remain unknown."
              }
            >
              {ufwLabels[choice]}
            </ChoiceButton>
          ))}
        </fieldset>
        <label
          htmlFor="quick-setup-recovery-acknowledged"
          className="flex items-start gap-3 rounded-lg border p-3 text-sm"
        >
          <Checkbox
            id="quick-setup-recovery-acknowledged"
            checked={draft.access.recoveryAcknowledged}
            onCheckedChange={(checked) =>
              update((current) => ({
                ...current,
                access: {
                  ...current.access,
                  recoveryAcknowledged: checked === true,
                },
              }))
            }
            className="mt-0.5"
          />
          <span>
            I understand that provider firewall access, IPv4/IPv6 reachability
            and out-of-band recovery readiness are unverified.
          </span>
        </label>
        <p className="text-xs leading-relaxed text-muted-foreground">
          This flag is not approval or a verified recovery check.
        </p>
      </StepSection>
    );
  } else if (draft.step === 5) {
    stepContent = (
      <StepSection step={5} title="Application stack">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Choose the application direction. Existing workloads, engines, proxies
          and occupied ports are not inspected.
        </p>
        <fieldset aria-label="Application stack" className="grid min-w-0 gap-2">
          {(["dokploy", "javascript", "containers", "skip"] as const).map(
            (choice) => (
              <ChoiceButton
                key={choice}
                selected={draft.stack.choice === choice}
                onClick={() => chooseStack(choice)}
                description={stackDescriptions[choice]}
              >
                {stackLabels[choice]}
              </ChoiceButton>
            ),
          )}
        </fieldset>
        {draft.stack.choice === "dokploy" ? (
          <p className="rounded-lg border bg-muted/30 p-3 text-sm">
            Docker is required for Dokploy. Podman is not offered as a
            substitute.
          </p>
        ) : draft.stack.choice === "skip" ? (
          <p className="text-sm text-muted-foreground">
            No container engine is planned for the skipped stack.
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-sm font-medium">Container engine (optional)</p>
            <fieldset
              aria-label="Container engine"
              className="grid min-w-0 gap-2 sm:grid-cols-3"
            >
              <ChoiceButton
                selected={draft.stack.engine === null}
                onClick={() =>
                  update((current) => ({
                    ...current,
                    stack: { ...current.stack, engine: null },
                  }))
                }
              >
                No engine
              </ChoiceButton>
              {(["docker", "podman"] as const).map((engine) => (
                <ChoiceButton
                  key={engine}
                  selected={draft.stack.engine === engine}
                  onClick={() =>
                    update((current) => ({
                      ...current,
                      stack: { ...current.stack, engine },
                    }))
                  }
                >
                  {quickSetupCatalogLabel(engine)}
                </ChoiceButton>
              ))}
            </fieldset>
            {plan.missing.map((message) => (
              <p key={message} role="status" className="text-xs text-warning">
                {message}
              </p>
            ))}
          </div>
        )}
      </StepSection>
    );
  } else if (draft.step === 6) {
    stepContent = (
      <StepSection step={6} title="Developer tools">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Select the editor and utilities to plan. Existing configuration is
          preserved by default.
        </p>
        <fieldset
          aria-label="Editor"
          className="grid min-w-0 gap-2 sm:grid-cols-3"
        >
          {(["none", "neovim", "lazyvim"] as const).map((editor) => (
            <ChoiceButton
              key={editor}
              selected={draft.tools.editor === editor}
              onClick={() =>
                update((current) => ({
                  ...current,
                  tools: { ...current.tools, editor },
                }))
              }
              description={editorDescriptions[editor]}
            >
              {editorLabels[editor]}
            </ChoiceButton>
          ))}
        </fieldset>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {quickSetupHerdr.label}: {quickSetupHerdr.reason}
        </p>
        <div className="space-y-2">
          <p className="text-sm font-medium">Curated utilities</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {quickSetupUtilities.map((id) => (
              <label
                key={id}
                htmlFor={`quick-setup-utility-${id}`}
                className="flex items-center gap-3 text-sm"
              >
                <Checkbox
                  id={`quick-setup-utility-${id}`}
                  checked={draft.tools.utilities.includes(id)}
                  onCheckedChange={() => toggleUtility(id)}
                />
                <span>
                  {(quickSetupCatalog as Record<string, { label: string }>)[id]
                    ?.label ?? id}
                </span>
              </label>
            ))}
          </div>
        </div>
      </StepSection>
    );
  } else if (draft.step === 7) {
    stepContent = (
      <StepSection step={7} title="Runtimes">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Select user-scoped runtimes. Dependencies are resolved once; a runtime
          required by the application stack is not installed twice.
        </p>
        <div className="space-y-2">
          <p className="text-sm font-medium">Runtime selections</p>
          {quickSetupRuntimes.map((id) => {
            const required = requiredRuntimes.includes(id);
            const selected = required || draft.runtimes.includes(id);
            return (
              <label
                key={id}
                htmlFor={`quick-setup-runtime-${id}`}
                className="flex items-center gap-3 text-sm"
              >
                <Checkbox
                  id={`quick-setup-runtime-${id}`}
                  checked={selected}
                  disabled={required}
                  aria-describedby={
                    required ? `quick-setup-runtime-${id}-required` : undefined
                  }
                  onCheckedChange={() => toggleRuntime(id)}
                />
                <span>
                  {(quickSetupCatalog as Record<string, { label: string }>)[id]
                    ?.label ?? id}
                  {required && (
                    <span
                      id={`quick-setup-runtime-${id}-required`}
                      className="ml-2 text-xs text-warning"
                    >
                      Required
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
        <div className="rounded-lg border bg-muted/30 p-3 text-sm">
          <p>
            {plan.items.length} unique{" "}
            {plan.items.length === 1 ? "item" : "items"} resolved.
            {plan.duplicateSelections
              ? ` ${plan.duplicateSelections} duplicate selection${plan.duplicateSelections === 1 ? "" : "s"} resolved once.`
              : " No duplicates."}
          </p>
          {draft.stack.choice === "javascript" && (
            <p className="mt-1 text-xs text-muted-foreground">
              NVM + Node.js is required by JavaScript / PM2 and is included
              once.
            </p>
          )}
          {draft.tools.editor === "lazyvim" && (
            <p className="mt-1 text-xs text-muted-foreground">
              LazyVim adds Git, ripgrep and fd once.
            </p>
          )}
        </div>
      </StepSection>
    );
  } else {
    stepContent = (
      <StepSection step={8} title="Review and finish">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Desired state for {profile.name}. This is a saved preview, not a
          verified server state.
        </p>
        <ConfigurationNotice title="Applying changes unavailable">
          Access recovery and executable installation are not available.
        </ConfigurationNotice>
        <ConfigurationNotice title="Security checkpoint not verified">
          Steps 1–4 are draft choices only. Host access, key login, firewall and
          recovery are unverified.
        </ConfigurationNotice>
        <div className="grid gap-3 sm:grid-cols-2">
          <SummaryCard title="Administrator">
            {draft.administrator.username} ·{" "}
            {adminModeLabels[draft.administrator.mode]}
          </SummaryCard>
          <SummaryCard title="SSH key">
            {keySelectionSummary(draft)}
            {draft.sshKey.generatedKeyId && (
              <p className="mt-1 text-xs">
                The selected key exists only in this app's local vault. No
                public key has been installed and no login has been verified.
              </p>
            )}
          </SummaryCard>
          <SummaryCard title="SSH and firewall">
            Port {draft.access.port} · {ufwLabels[draft.access.ufw]}
            <br />
            Recovery acknowledged:{" "}
            {draft.access.recoveryAcknowledged ? "Yes" : "No"} · unverified
          </SummaryCard>
          <SummaryCard title="Application stack">
            {stackLabels[draft.stack.choice]} ·{" "}
            {draft.stack.engine
              ? quickSetupCatalogLabel(draft.stack.engine)
              : "No container engine"}
          </SummaryCard>
          <SummaryCard title="Developer tools">
            {editorLabels[draft.tools.editor]}
            <br />
            {draft.tools.utilities.length
              ? draft.tools.utilities
                  .map((id) => quickSetupCatalogLabel(id))
                  .join(", ")
              : "No utilities"}
          </SummaryCard>
          <SummaryCard title="Runtimes">
            {draft.runtimes.length
              ? draft.runtimes
                  .map((id) => quickSetupCatalogLabel(id))
                  .join(", ")
              : "None selected"}
          </SummaryCard>
        </div>
        <section aria-label="Resolved catalog items" className="space-y-2">
          <h3 className="text-sm font-medium">Resolved items</h3>
          {plan.items.length ? (
            <ul className="space-y-1 text-sm">
              {plan.items.map((item) => (
                <li key={item.id} className="flex flex-wrap gap-x-2">
                  <span>{item.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {item.sources.join(" · ")}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No items selected.</p>
          )}
          {plan.missing.map((message) => (
            <p key={message} role="status" className="text-xs text-warning">
              {message}
            </p>
          ))}
        </section>
        <p className="text-sm font-medium">
          Draft saved. Applying changes is unavailable.
        </p>
      </StepSection>
    );
  }

  return (
    <section ref={page} aria-label="Quick Setup" className="space-y-6">
      <QuickSetupHeader profile={profile} connected={connected} />
      <ConfigurationNotice title="Setup preview">
        Choices are saved on this device. Generated SSH keys are created
        locally; server changes remain unavailable until access recovery is
        ready.
      </ConfigurationNotice>
      {noDraftStorage && (
        <p role="status" className="text-xs text-warning">
          This profile has no usable server UUID, so draft choices stay in
          memory only.
        </p>
      )}
      <nav aria-label="Quick Setup steps" className="min-w-0">
        <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {quickSetupSteps.map((item) => {
            const active = item.id === draft.step;
            return (
              <li key={item.id} className="min-w-0">
                <Button
                  type="button"
                  size="sm"
                  variant={active ? "secondary" : "outline"}
                  aria-current={active ? "step" : undefined}
                  aria-label={`Step ${item.id}: ${item.title}`}
                  disabled={item.id > draft.step && forwardBlocked}
                  onClick={() => changeStep(item.id)}
                  className="h-auto min-h-9 w-full justify-start whitespace-normal text-left"
                >
                  <span aria-hidden="true" className="tabular-nums">
                    {item.id}
                  </span>
                  <span className="min-w-0">{item.title}</span>
                </Button>
              </li>
            );
          })}
        </ol>
      </nav>
      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 space-y-5">
          {stepContent}
          <TechnicalDetails />
          <footer className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <Button
              type="button"
              variant="outline"
              disabled={draft.step === 1}
              onClick={() => changeStep((draft.step - 1) as QuickSetupStepId)}
            >
              Back
            </Button>
            {draft.step === 8 ? (
              <p className="text-xs text-muted-foreground">
                Applying changes is unavailable.
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                {forwardBlocked ? (
                  <p role="status" className="text-xs text-destructive">
                    Fix the administrator username or SSH port before
                    continuing.
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Navigation saves draft choices only.
                  </p>
                )}
                <Button
                  type="button"
                  disabled={forwardBlocked}
                  onClick={() =>
                    changeStep((draft.step + 1) as QuickSetupStepId)
                  }
                >
                  Next step
                </Button>
              </div>
            )}
          </footer>
        </div>
        <aside
          aria-label="Draft summary"
          className="min-w-0 space-y-3 self-start rounded-xl border bg-card p-4"
        >
          <h2 className="text-sm font-medium">Draft summary</h2>
          <dl className="space-y-2 text-xs leading-relaxed">
            <div>
              <dt className="text-muted-foreground">Administrator</dt>
              <dd className="break-words">
                {draft.administrator.username} ·{" "}
                {adminModeLabels[draft.administrator.mode]}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">SSH key</dt>
              <dd>{keySelectionSummary(draft)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Port / firewall</dt>
              <dd>
                {draft.access.port} · {ufwLabels[draft.access.ufw]}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Stack</dt>
              <dd>
                {stackLabels[draft.stack.choice]}
                {draft.stack.engine
                  ? ` · ${quickSetupCatalogLabel(draft.stack.engine)}`
                  : ""}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Editor</dt>
              <dd>{editorLabels[draft.tools.editor]}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Runtimes</dt>
              <dd>
                {draft.runtimes.length
                  ? draft.runtimes
                      .map((id) => quickSetupCatalogLabel(id))
                      .join(", ")
                  : "None selected"}
              </dd>
            </div>
          </dl>
          <p role="status" className="text-xs text-muted-foreground">
            {saved
              ? "Draft saved on this device. No choice is verified."
              : "Draft is in memory until you change a choice or navigate."}
          </p>
        </aside>
      </div>
    </section>
  );
}

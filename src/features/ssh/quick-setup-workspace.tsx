import {
  type ReactNode,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ConfigurationNotice } from "@/components/configuration-status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  getPreferenceSaveState,
  retryPreference,
  subscribePreferenceSaveState,
} from "@/features/settings/persistence";
import { type ServerProfile, useConnectionStatuses } from "./api";
import { useConfiguration } from "./configuration-context";
import {
  quickSetupCatalog,
  quickSetupCatalogLabel,
} from "./quick-setup-catalog";
import { CheckRow, ChoiceGroup, ChoiceRow } from "./quick-setup-controls";
import { stepItems } from "./quick-setup-execution-model";
import { QuickSetupFirewallControls } from "./quick-setup-firewall";
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
  quickSetupStepNumber,
  quickSetupSteps,
  quickSetupUtilities,
  readQuickSetupDraft,
  requiredQuickSetupRuntimes,
  resolveQuickSetupAccessTargets,
  resolveQuickSetupPlan,
  sanitizeQuickSetupDraft,
  validateQuickSetupUsername,
  writeQuickSetupDraft,
} from "./quick-setup-model";
import {
  QuickSetupPackageProvider,
  QuickSetupPackageStatus,
  QuickSetupPackages,
  useSetupPackages,
} from "./quick-setup-packages";
import { QuickSetupSecurity } from "./quick-setup-security";

const adminModeLabels: Record<QuickSetupAdminMode, string> = {
  new: "Create a new administrator",
  existing: "Use an existing administrator",
};
const keyStrategyLabels: Record<QuickSetupKeyStrategy, string> = {
  existing: "Use an existing key",
  generate: "Generate a new key",
  agent: "Use the SSH agent",
};
const ufwLabels: Record<QuickSetupUfwChoice, string> = {
  configure: "Configure UFW",
  "keep-current": "Keep the current firewall",
};
const stackLabels: Record<QuickSetupStackChoice, string> = {
  dokploy: "Dokploy",
  javascript: "JavaScript / PM2",
  containers: "Container foundation",
  skip: "Skip application stack",
};
const editorLabels: Record<QuickSetupEditorChoice, string> = {
  none: "Skip editor",
  neovim: "Neovim",
  lazyvim: "Neovim + LazyVim",
};
const runtimeGroups: {
  id: string;
  title: string;
  description: string;
  runtimes: readonly QuickSetupRuntimeId[];
}[] = [
  {
    id: "javascript",
    title: "JavaScript / TypeScript",
    description: "Bun or Node.js through NVM.",
    runtimes: ["bun", "nvm-node"],
  },
  {
    id: "python",
    title: "Python",
    description: "uv or the distribution's signed Python 3 packages.",
    runtimes: ["uv", "python"],
  },
  {
    id: "go",
    title: "Go",
    description: "Official stable Go archive for this OS and architecture.",
    runtimes: ["go"],
  },
];

function DraftSaveStatus({ draftKey }: { draftKey: string | null }) {
  const subscribe = useCallback(
    (listener: () => void) =>
      draftKey ? subscribePreferenceSaveState(draftKey, listener) : () => {},
    [draftKey],
  );
  const getSnapshot = useCallback(
    () => (draftKey ? getPreferenceSaveState(draftKey).status : "idle"),
    [draftKey],
  );
  const status = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (!draftKey || status === "idle") return null;
  return (
    <span
      role="status"
      aria-live="polite"
      aria-label="Draft save status"
      className="inline-flex items-center gap-2 text-xs text-muted-foreground"
    >
      {status === "saving"
        ? "Saving…"
        : status === "saved"
          ? "Saved"
          : "Could not save"}
      {status === "error" && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-my-1 h-6 px-2 text-xs"
          onClick={() => void retryPreference(draftKey)}
        >
          Retry
        </Button>
      )}
    </span>
  );
}

function QuickSetupHeader({
  step,
  draftKey,
}: {
  step?: number;
  draftKey?: string | null;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-2">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">Quick Setup</h1>
        {step !== undefined && (
          <p className="mt-1 hidden text-sm text-muted-foreground md:block">
            Step {quickSetupStepNumber(step as QuickSetupStepId)} of{" "}
            {quickSetupSteps.length}
          </p>
        )}
      </div>
      {step !== undefined && (
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <DraftSaveStatus draftKey={draftKey ?? null} />
        </div>
      )}
    </header>
  );
}

function StepSection({
  step,
  title,
  description,
  children,
}: {
  step: QuickSetupStepId;
  title: string;
  description: string;
  children: ReactNode;
}) {
  const headingId = `${useId()}-step-${step}`;
  return (
    <section aria-labelledby={headingId} className="space-y-5">
      <div className="space-y-1.5">
        <h2 id={headingId} className="text-lg font-semibold tracking-tight">
          {title}
        </h2>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

function stepDisplayTitle(item: { title: string }) {
  return item.title;
}

function StepNavigation({
  step,
  forwardBlocked,
  onChange,
}: {
  step: QuickSetupStepId;
  forwardBlocked: boolean;
  onChange: (step: QuickSetupStepId) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const current =
    quickSetupSteps.find((item) => item.id === step) ?? quickSetupSteps[0];
  function select(id: QuickSetupStepId, returnFocus = false) {
    setOpen(false);
    onChange(id);
    if (returnFocus) requestAnimationFrame(() => trigger.current?.focus());
  }
  return (
    <nav
      aria-label="Quick Setup steps"
      className="min-w-0 md:sticky md:top-8 md:self-start"
    >
      <div className="md:hidden">
        <Button
          ref={trigger}
          type="button"
          variant="ghost"
          aria-expanded={open}
          aria-controls={listId}
          aria-label={`Current step ${quickSetupStepNumber(step)}: ${current.title}. ${open ? "Hide" : "Show"} all steps`}
          onClick={() => setOpen((value) => !value)}
          className="h-auto w-full justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-left font-normal whitespace-normal"
        >
          <span className="min-w-0">
            <span className="block text-xs text-muted-foreground">
              Step {quickSetupStepNumber(step as QuickSetupStepId)} of{" "}
              {quickSetupSteps.length}
            </span>
            <span className="block text-sm font-medium">
              {stepDisplayTitle(current)}
            </span>
          </span>
          <span className="text-xs text-muted-foreground">
            {open ? "Hide" : "Show"}
          </span>
        </Button>
        {open && (
          <ol
            id={listId}
            className="mt-1 divide-y divide-border/70 border-y border-border/70"
          >
            {quickSetupSteps.map((item) => {
              const active = item.id === step;
              return (
                <li key={item.id}>
                  <Button
                    type="button"
                    variant="ghost"
                    aria-current={active ? "step" : undefined}
                    aria-label={`Step ${quickSetupStepNumber(item.id)}: ${item.title}`}
                    disabled={item.id > step && forwardBlocked}
                    onClick={() => select(item.id, true)}
                    className={`h-auto w-full justify-start gap-2.5 rounded-none border-y-0 border-r-0 border-l-2 px-3 py-2 text-left font-normal whitespace-normal ${
                      active
                        ? "border-l-primary text-foreground"
                        : "border-l-transparent text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <span className="w-4 text-xs tabular-nums">
                      {quickSetupStepNumber(item.id)}
                    </span>
                    <span className="min-w-0 text-sm">
                      {stepDisplayTitle(item)}
                    </span>
                  </Button>
                </li>
              );
            })}
          </ol>
        )}
      </div>
      <ol className="hidden space-y-0.5 md:block">
        {quickSetupSteps.map((item) => {
          const active = item.id === step;
          return (
            <li key={item.id}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-current={active ? "step" : undefined}
                aria-label={`Step ${quickSetupStepNumber(item.id)}: ${item.title}`}
                disabled={item.id > step && forwardBlocked}
                onClick={() => select(item.id)}
                className={`h-auto w-full justify-start gap-2.5 rounded-none border-y-0 border-r-0 border-l-2 px-2 py-1.5 text-left font-normal whitespace-normal ${
                  active
                    ? "border-l-primary text-foreground"
                    : "border-l-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                <span className="w-4 text-xs tabular-nums">
                  {quickSetupStepNumber(item.id)}
                </span>
                <span className="min-w-0 text-sm">
                  {stepDisplayTitle(item)}
                </span>
              </Button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1 py-2.5 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-xs text-muted-foreground sm:text-sm">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

function QuickSetupWorkspaceContent({
  visible = true,
  profile,
  connected,
  onOpenProfile,
}: {
  profile: ServerProfile;
  connected: boolean;
  visible?: boolean;
  onOpenProfile?: (profileId: string) => void;
}) {
  const fieldPrefix = useId();
  const packages = useSetupPackages();
  const statuses = useConnectionStatuses(visible && connected);
  const currentStatus = statuses.data?.find(
    (item) => item.profileId === profile.id,
  );
  const authentication = statuses.data?.find(
    (item) => item.profileId === profile.id,
  )?.authenticationMethod;
  const [finished, setFinished] = useState(false);
  const [securityBusy, setSecurityBusy] = useState(false);
  const [securityVerified, setSecurityVerified] = useState(false);
  const [securityDraftChanged, setSecurityDraftChanged] = useState(false);
  const { connectionId } = useConfiguration();
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
    if (
      draft &&
      JSON.stringify(draft.access) !== JSON.stringify(clean.access)
    ) {
      setSecurityVerified(false);
      setSecurityDraftChanged(true);
    }
    setDraft(clean);
    setInvalid(false);
    writeQuickSetupDraft(profile.id, clean);
  }
  function update(mutate: (current: QuickSetupDraft) => QuickSetupDraft) {
    if (draft) commit(mutate(draft));
  }
  function changeStep(step: QuickSetupStepId) {
    if (!draft || securityBusy) return;
    setFinished(false);
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
      <section
        ref={page}
        aria-label="Quick Setup"
        className="mx-auto w-full max-w-[1000px] space-y-6"
      >
        <QuickSetupHeader />
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
  const accessTargets = resolveQuickSetupAccessTargets(profile, draft);
  const requiredRuntimes = requiredQuickSetupRuntimes(draft);
  const forwardBlocked = Boolean(usernameError || portError);
  const draftKey = quickSetupDraftKey(profile.id);
  const noDraftStorage = draftKey === null;

  let stepContent: ReactNode;
  if (draft.step === 1) {
    stepContent = (
      <StepSection step={1} title="Connection overview" description="">
        <dl className="divide-y divide-border/70 border-y border-border/70">
          <DetailRow label="Profile">{profile.name}</DetailRow>
          <DetailRow label="Address">
            {profile.username}@{profile.host}:{profile.port}
          </DetailRow>
          <DetailRow label="Connection">
            {connected ? "Connected" : "Disconnected"}
          </DetailRow>
          <DetailRow label="Authentication">
            {!connected
              ? "Disconnected"
              : authentication === "password"
                ? "Password"
                : authentication === "key"
                  ? "SSH key"
                  : authentication === "agent"
                    ? "SSH agent"
                    : authentication === "none"
                      ? "No authentication required"
                      : "Unknown"}
          </DetailRow>
          <DetailRow label="Administrator">
            {profile.username === "root"
              ? "Root account"
              : currentStatus?.setupAccessVerified
                ? "Sudo verified"
                : "Sudo access needs verification"}
          </DetailRow>
          <DetailRow label="Saved key">
            {profile.identityFile || "SSH agent / default keys"}
          </DetailRow>
        </dl>
      </StepSection>
    );
  } else if (draft.step === 3) {
    stepContent = (
      <StepSection step={3} title="Administrator & SSH key" description="">
        <ChoiceGroup label="Administrator choice">
          {(["new", "existing"] as const).map((mode) => (
            <ChoiceRow
              key={mode}
              selected={draft.administrator.mode === mode}
              onClick={() =>
                update((current) => ({
                  ...current,
                  administrator: { ...current.administrator, mode },
                }))
              }
              label={adminModeLabels[mode]}
            />
          ))}
        </ChoiceGroup>
        <div className="max-w-sm space-y-1.5">
          <label htmlFor={`${fieldPrefix}-username`} className="block text-sm">
            Administrator username
          </label>
          <Input
            id={`${fieldPrefix}-username`}
            value={usernameText}
            maxLength={32}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={Boolean(usernameError)}
            aria-describedby={
              usernameError ? `${fieldPrefix}-username-error` : undefined
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
        </div>
        {usernameError && (
          <p
            id={`${fieldPrefix}-username-error`}
            role="alert"
            className="text-xs text-destructive"
          >
            {usernameError}
          </p>
        )}
        <ChoiceGroup label="SSH key strategy">
          {(["existing", "generate"] as const).map((strategy) => (
            <div key={strategy}>
              <ChoiceRow
                selected={draft.sshKey.strategy === strategy}
                onClick={() =>
                  update((current) =>
                    current.sshKey.strategy === strategy
                      ? current
                      : { ...current, sshKey: { strategy } },
                  )
                }
                label={keyStrategyLabels[strategy]}
              />
            </div>
          ))}
        </ChoiceGroup>
        {(draft.sshKey.strategy === "existing" ||
          draft.sshKey.strategy === "generate") && (
          <QuickSetupKeyManager
            visible={visible}
            key={draft.sshKey.strategy}
            strategy={draft.sshKey.strategy}
            selectedKeyId={
              draft.sshKey.strategy === "existing"
                ? draft.sshKey.existingKeyId
                : draft.sshKey.generatedKeyId
            }
            onSelectKey={(keyId) =>
              update((current) => {
                if (current.sshKey.strategy === "existing")
                  return {
                    ...current,
                    sshKey: { strategy: "existing", existingKeyId: keyId },
                  };
                if (current.sshKey.strategy === "generate")
                  return {
                    ...current,
                    sshKey: { strategy: "generate", generatedKeyId: keyId },
                  };
                return current;
              })
            }
            source={{
              profileId: profile.id,
              profileRevision: profile.revision,
              host: profile.host,
              username: accessTargets.current.username,
              port: accessTargets.current.port,
            }}
            plannedTarget={accessTargets.planned}
            adminMode={draft.administrator.mode}
            adminUsername={draft.administrator.username}
            plannedPort={draft.access.port}
            connectionId={connectionId}
            connected={connected}
            onOpenProfile={onOpenProfile ?? (() => {})}
          />
        )}
      </StepSection>
    );
  } else if (draft.step === 4) {
    stepContent = (
      <StepSection step={4} title="SSH & firewall" description="">
        <div className="max-w-40 space-y-1.5">
          <label htmlFor={`${fieldPrefix}-port`} className="block text-sm">
            SSH port
          </label>
          <Input
            id={`${fieldPrefix}-port`}
            inputMode="numeric"
            value={portText}
            maxLength={5}
            autoComplete="off"
            aria-invalid={Boolean(portError)}
            aria-describedby={
              portError ? `${fieldPrefix}-port-error` : undefined
            }
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
        </div>
        {portError && (
          <p
            id={`${fieldPrefix}-port-error`}
            role="alert"
            className="text-xs text-destructive"
          >
            {portError}
          </p>
        )}
        <ChoiceGroup label="Firewall choice">
          {(["configure", "keep-current"] as const).map((choice) => (
            <ChoiceRow
              key={choice}
              selected={draft.access.ufw === choice}
              onClick={() =>
                update((current) => ({
                  ...current,
                  access: { ...current.access, ufw: choice },
                }))
              }
              label={ufwLabels[choice]}
              description={
                choice === "configure"
                  ? "Allow selected inbound ports."
                  : "Leave existing rules unchanged."
              }
            />
          ))}
        </ChoiceGroup>
        <QuickSetupFirewallControls
          draft={draft}
          currentPort={profile.port}
          idPrefix={fieldPrefix}
          onChange={(access) => update((current) => ({ ...current, access }))}
        />
      </StepSection>
    );
  } else if (draft.step === 5) {
    stepContent = (
      <StepSection step={5} title="Application stack" description="">
        <ChoiceGroup label="Application stack">
          {(["dokploy", "javascript", "containers", "skip"] as const).map(
            (choice) => (
              <ChoiceRow
                key={choice}
                selected={draft.stack.choice === choice}
                onClick={() => chooseStack(choice)}
                label={stackLabels[choice]}
                status={
                  choice === "skip" ? undefined : choice === "containers" ? (
                    <QuickSetupPackageStatus
                      id={draft.stack.engine ?? "containers"}
                    />
                  ) : (
                    <QuickSetupPackageStatus
                      id={choice === "javascript" ? "javascript-pm2" : choice}
                      dependencies={
                        choice === "javascript"
                          ? ["nvm-node"]
                          : choice === "dokploy"
                            ? ["docker"]
                            : []
                      }
                    />
                  )
                }
              />
            ),
          )}
        </ChoiceGroup>
        {draft.stack.choice !== "dokploy" && draft.stack.choice !== "skip" && (
          <div className="space-y-2">
            <p className="text-sm font-medium">
              {draft.stack.choice === "containers"
                ? "Container engine"
                : "Container engine (optional)"}
            </p>
            <fieldset aria-label="Container engine" className="min-w-0">
              <legend className="sr-only">Container engine</legend>
              <div className="grid grid-cols-3 gap-1.5">
                {(
                  [
                    { value: null, label: "No engine" },
                    {
                      value: "docker",
                      label: quickSetupCatalogLabel("docker"),
                    },
                    {
                      value: "podman",
                      label: quickSetupCatalogLabel("podman"),
                    },
                  ] as const
                ).map((option) => {
                  const selected = draft.stack.engine === option.value;
                  return (
                    <Button
                      key={option.label}
                      type="button"
                      variant="ghost"
                      aria-pressed={selected}
                      onClick={() =>
                        update((current) => ({
                          ...current,
                          stack: {
                            ...current.stack,
                            engine: option.value,
                          },
                        }))
                      }
                      className="h-auto min-w-0 justify-between gap-2 rounded-none border border-border/70 px-2.5 py-2 text-left font-normal whitespace-normal aria-pressed:border-primary aria-pressed:text-foreground"
                    >
                      <span className="min-w-0 text-sm">
                        {option.label}
                        {option.value && (
                          <QuickSetupPackageStatus id={option.value} />
                        )}
                      </span>
                      <span
                        aria-hidden="true"
                        className={`flex size-4 shrink-0 items-center justify-center rounded-full border ${
                          selected
                            ? "border-primary"
                            : "border-muted-foreground"
                        }`}
                      >
                        {selected && (
                          <span className="size-2 rounded-full bg-primary" />
                        )}
                      </span>
                    </Button>
                  );
                })}
              </div>
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
      <StepSection step={6} title="Developer tools" description="">
        <div className="space-y-2">
          <p className="text-sm font-medium">Editor</p>
          <ChoiceGroup label="Editor">
            {(["none", "neovim", "lazyvim"] as const).map((editor) => (
              <div key={editor}>
                <ChoiceRow
                  selected={draft.tools.editor === editor}
                  onClick={() =>
                    update((current) => ({
                      ...current,
                      tools: { ...current.tools, editor },
                    }))
                  }
                  label={editorLabels[editor]}
                  status={
                    editor === "none" ? undefined : (
                      <QuickSetupPackageStatus
                        id={editor === "lazyvim" ? "lazyvim-starter" : "neovim"}
                        dependencies={
                          editor === "lazyvim"
                            ? ["neovim", "git", "ripgrep", "fd"]
                            : []
                        }
                      />
                    )
                  }
                />
              </div>
            ))}
          </ChoiceGroup>
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">Utilities</p>
          <div className="grid gap-x-6 border-y border-border/70 lg:grid-cols-2">
            {quickSetupUtilities.map((id) => (
              <div
                key={id}
                className="border-b border-border/70 pb-1 last:border-b-0 lg:[&:nth-last-child(-n+2)]:border-b-0"
              >
                <CheckRow
                  id={`${fieldPrefix}-utility-${id}`}
                  label={quickSetupCatalog[id].label}
                  status={<QuickSetupPackageStatus id={id} />}
                  checked={
                    draft.tools.utilities.includes(id) ||
                    (draft.tools.editor === "lazyvim" &&
                      ["git", "ripgrep", "fd"].includes(id))
                  }
                  disabled={
                    draft.tools.editor === "lazyvim" &&
                    ["git", "ripgrep", "fd"].includes(id)
                  }
                  requiredNote={
                    draft.tools.editor === "lazyvim" &&
                    ["git", "ripgrep", "fd"].includes(id)
                      ? "Required by LazyVim."
                      : undefined
                  }
                  onToggle={() => toggleUtility(id)}
                />
              </div>
            ))}
          </div>
        </div>
      </StepSection>
    );
  } else if (draft.step === 7) {
    stepContent = (
      <StepSection step={7} title="Runtimes" description="">
        <div className="grid gap-3 md:grid-cols-2">
          {runtimeGroups.map((group) => {
            const headingId = `${fieldPrefix}-runtime-group-${group.id}`;
            return (
              <section
                key={group.id}
                aria-labelledby={headingId}
                className="rounded-lg border border-border/70 p-3"
              >
                <h3 id={headingId} className="text-sm font-medium">
                  {group.title}
                </h3>

                <div className="mt-1 divide-y divide-border/70">
                  {group.runtimes.map((id) => {
                    const required = requiredRuntimes.includes(id);
                    const selected = required || draft.runtimes.includes(id);
                    return (
                      <CheckRow
                        key={id}
                        id={`${fieldPrefix}-runtime-${id}`}
                        label={quickSetupCatalog[id].label}
                        status={<QuickSetupPackageStatus id={id} />}
                        requiredNote={
                          required ? "Required by JavaScript / PM2." : undefined
                        }
                        checked={selected}
                        disabled={required}
                        onToggle={() => toggleRuntime(id)}
                      />
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      </StepSection>
    );
  }

  if (finished) {
    const groups = [
      { step: 5 as const, label: "Application stack" },
      { step: 6 as const, label: "Developer tools" },
      { step: 7 as const, label: "Runtimes" },
    ];
    return (
      <section
        aria-label="Quick Setup completion"
        className="mx-auto max-w-[780px] space-y-5"
      >
        <h1 className="text-xl font-semibold">Setup summary</h1>
        <p className="text-sm text-muted-foreground">
          {profile.username}@{profile.host}:{profile.port}
        </p>
        <ul className="divide-y border-y text-sm">
          <li className="flex items-center justify-between gap-3 py-3">
            <span>Administrator & SSH key</span>
            <Button variant="ghost" size="sm" onClick={() => changeStep(3)}>
              Check access
            </Button>
          </li>
          <li className="flex items-center justify-between gap-3 py-3">
            <span>
              SSH & firewall ·{" "}
              {securityVerified ||
              (!securityDraftChanged && currentStatus?.setupAccessVerified)
                ? "Verified"
                : "Unfinished"}
            </span>
            <Button variant="ghost" size="sm" onClick={() => changeStep(4)}>
              Continue
            </Button>
          </li>
          {groups.map((group) => {
            const selected = stepItems({ ...draft, step: group.step });
            const installed = selected.filter(
              (item) =>
                packages.items.find((row) => row.id === item.id)?.status ===
                "installed",
            ).length;
            return (
              <li
                key={group.step}
                className="flex items-center justify-between gap-3 py-3"
              >
                <span>
                  {group.label} ·{" "}
                  {selected.length
                    ? `${installed}/${selected.length} installed`
                    : "Skipped"}
                </span>
                {installed < selected.length && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => changeStep(group.step)}
                  >
                    Continue
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
        <Button variant="outline" onClick={() => changeStep(1)}>
          Back to setup
        </Button>
      </section>
    );
  }

  return (
    <section
      ref={page}
      aria-label="Quick Setup"
      className="mx-auto w-full max-w-[1000px] space-y-7"
    >
      <QuickSetupHeader draftKey={draftKey} step={draft.step} />
      {noDraftStorage && (
        <p role="status" className="text-xs text-warning">
          This profile has no usable server UUID, so draft choices stay in
          memory only.
        </p>
      )}
      <div className="grid min-w-0 gap-8 md:grid-cols-[168px_minmax(0,1fr)]">
        <StepNavigation
          step={draft.step}
          forwardBlocked={forwardBlocked}
          onChange={changeStep}
        />
        <div className="min-w-0 max-w-[620px] space-y-6">
          <fieldset
            disabled={packages.busy || securityBusy}
            className="min-w-0 border-0 p-0"
          >
            {stepContent}
          </fieldset>
          <div hidden={draft.step !== 4}>
            <QuickSetupSecurity
              profile={profile}
              draft={draft}
              visible={visible && draft.step === 4}
              onBusyChange={setSecurityBusy}
              onVerified={setSecurityVerified}
              onChange={(access) =>
                update((current) => ({ ...current, access }))
              }
              onOpenProfile={onOpenProfile}
            />
          </div>
          {draft.step >= 5 && (
            <QuickSetupPackages
              key={draft.step}
              profile={profile}
              draft={draft}
              visible={visible}
            />
          )}
          <footer className="flex items-center justify-between gap-3 border-t border-border/70 pt-4">
            <Button
              type="button"
              variant="ghost"
              disabled={draft.step === 1 || securityBusy}
              onClick={() =>
                changeStep(
                  quickSetupSteps[
                    Math.max(0, quickSetupStepNumber(draft.step) - 2)
                  ].id,
                )
              }
            >
              Back
            </Button>
            {draft.step === 7 ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => setFinished(true)}
                disabled={packages.busy || securityBusy}
              >
                Finish
              </Button>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                {forwardBlocked ? (
                  <p role="status" className="text-xs text-destructive">
                    Fix the administrator username or SSH port before
                    continuing.
                  </p>
                ) : null}
                <Button
                  type="button"
                  disabled={forwardBlocked || securityBusy}
                  onClick={() =>
                    changeStep(
                      quickSetupSteps[
                        Math.min(5, quickSetupStepNumber(draft.step))
                      ].id,
                    )
                  }
                >
                  Next step
                </Button>
              </div>
            )}
          </footer>
        </div>
      </div>
    </section>
  );
}

export function QuickSetupWorkspace(
  props: Parameters<typeof QuickSetupWorkspaceContent>[0],
) {
  const { connectionId } = useConfiguration();
  return (
    <QuickSetupPackageProvider
      key={`${props.profile.id}:${props.profile.revision}:${connectionId ?? "disconnected"}`}
      profile={props.profile}
      visible={props.visible ?? true}
    >
      <QuickSetupWorkspaceContent {...props} />
    </QuickSetupPackageProvider>
  );
}

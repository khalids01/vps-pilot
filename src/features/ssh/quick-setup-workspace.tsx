import {
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ConfigurationNotice } from "@/components/configuration-status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ServerProfile } from "./api";
import { useConfiguration } from "./configuration-context";
import {
  quickSetupCatalog,
  quickSetupCatalogLabel,
  quickSetupHerdr,
  quickSetupSourcePolicy,
} from "./quick-setup-catalog";
import { CheckRow, ChoiceGroup, ChoiceRow } from "./quick-setup-controls";
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
  quickSetupSteps,
  quickSetupUtilities,
  readQuickSetupDraft,
  requiredQuickSetupRuntimes,
  resolveQuickSetupFirewallPlan,
  resolveQuickSetupPlan,
  sanitizeQuickSetupDraft,
  validateQuickSetupUsername,
  writeQuickSetupDraft,
} from "./quick-setup-model";
import {
  PlannedSourceDisclosure,
  QuickSetupResolvedSources,
} from "./quick-setup-sources";

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
  existing: "Choose a private key file already on this device.",
  generate: "Create a key file in ~/.ssh with an optional passphrase.",
  agent: "A key loaded in your desktop SSH agent.",
};
const keyStrategyExplanations: Record<QuickSetupKeyStrategy, string> = {
  existing:
    "The native file picker is functional. VPS Pilot stores an opaque local reference and public identity metadata; it never copies, moves, or changes the original private key. Keys outside ~/.ssh stay at their original path.",
  generate:
    "Creates an actual Ed25519 key pair in ~/.ssh with a filename you choose. Leave the passphrase blank for an unencrypted private key, or use 12 to 4096 bytes to encrypt it. Existing files are never overwritten; backup, public-key installation, and verification remain separate explicit steps.",
  agent:
    "Uses a key already loaded in your desktop SSH agent. The optional local desktop key cache is not used for authentication and no private key file is copied. Selecting an agent key is planning only.",
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
  dokploy: "Deploy applications with Docker. Includes Docker.",
  javascript: "Node.js through NVM, managed by PM2.",
  containers: "Docker or Podman for your own stack.",
  skip: "Set up server access only.",
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
  lazyvim: "Official stable Neovim with the official LazyVim starter.",
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

function keySelectionSummary(draft: QuickSetupDraft) {
  if (draft.sshKey.strategy === "generate" && draft.sshKey.generatedKeyId)
    return "Generated local key selected";
  if (draft.sshKey.strategy === "existing" && draft.sshKey.existingKeyId)
    return "Existing private key selected";
  return keyStrategyLabels[draft.sshKey.strategy];
}

function QuickSetupHeader({ step }: { step?: number }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-2">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">Quick Setup</h1>
        {step !== undefined && (
          <p className="mt-1 hidden text-sm text-muted-foreground md:block">
            Step {step} of {quickSetupSteps.length}
          </p>
        )}
      </div>
      {step !== undefined && (
        <aside
          aria-label="Setup preview"
          className="max-w-md text-xs leading-relaxed text-muted-foreground sm:text-right"
        >
          Choices save on this device. Server changes are unavailable.
        </aside>
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
        <p className="text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>
      {children}
    </section>
  );
}

function stepDisplayTitle(item: { id: QuickSetupStepId; title: string }) {
  if (item.id === 1) return "Connection";
  if (item.id === 8) return "Review";
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
          aria-label={`Current step ${step}: ${current.title}. ${open ? "Hide" : "Show"} all steps`}
          onClick={() => setOpen((value) => !value)}
          className="h-auto w-full justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-left font-normal whitespace-normal"
        >
          <span className="min-w-0">
            <span className="block text-xs text-muted-foreground">
              Step {step} of {quickSetupSteps.length}
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
                    aria-label={`Step ${item.id}: ${item.title}`}
                    disabled={item.id > step && forwardBlocked}
                    onClick={() => select(item.id, true)}
                    className={`h-auto w-full justify-start gap-2.5 rounded-none border-y-0 border-r-0 border-l-2 px-3 py-2 text-left font-normal whitespace-normal ${
                      active
                        ? "border-l-primary text-foreground"
                        : "border-l-transparent text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <span className="w-4 text-xs tabular-nums">{item.id}</span>
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
                aria-label={`Step ${item.id}: ${item.title}`}
                disabled={item.id > step && forwardBlocked}
                onClick={() => select(item.id)}
                className={`h-auto w-full justify-start gap-2.5 rounded-none border-y-0 border-r-0 border-l-2 px-2 py-1.5 text-left font-normal whitespace-normal ${
                  active
                    ? "border-l-primary text-foreground"
                    : "border-l-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                <span className="w-4 text-xs tabular-nums">{item.id}</span>
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

function TechnicalDetails({ children }: { children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-border/70 pt-4">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="-ml-2.5 text-muted-foreground"
      >
        Technical details
      </Button>
      {open && (
        <div className="mt-2 space-y-3 text-xs leading-relaxed text-muted-foreground">
          {children}
          <p>{quickSetupSourcePolicy}</p>
        </div>
      )}
    </div>
  );
}

const quickSetupPasswordByteLimit = 4096;
function passwordBytes(value: string) {
  return new TextEncoder().encode(value).length;
}

function ExpandableExplanation({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="px-2 pb-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="-ml-2.5 h-7 text-xs text-muted-foreground"
      >
        {label}
      </Button>
      {open && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {children}
        </p>
      )}
    </div>
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

export function QuickSetupWorkspace({
  profile,
  connected,
  active,
  onOpenInspection,
}: {
  profile: ServerProfile;
  connected: boolean;
  active: boolean;
  onOpenInspection: () => void;
}) {
  const fieldPrefix = useId();
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
  const [newAdminPassword, setNewAdminPassword] = useState("");
  const [newAdminPasswordConfirm, setNewAdminPasswordConfirm] = useState("");
  const [existingSudoPassword, setExistingSudoPassword] = useState("");
  const page = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    page.current?.closest("main")?.scrollTo({ top: 0 });
  }, []);
  const adminMode = draft?.administrator.mode;
  const draftStep = draft?.step;
  const secretScope = [
    active,
    adminMode,
    draftStep,
    profile.id,
    usernameText,
    connectionId,
    connected,
  ].join("|");
  const lastSecretScope = useRef(secretScope);
  useEffect(() => {
    if (lastSecretScope.current === secretScope) return;
    lastSecretScope.current = secretScope;
    setNewAdminPassword("");
    setNewAdminPasswordConfirm("");
    setExistingSudoPassword("");
  }, [secretScope]);

  function commit(next: QuickSetupDraft) {
    const clean = sanitizeQuickSetupDraft(next);
    if (!clean) return;
    setDraft(clean);
    setInvalid(false);
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
    setNewAdminPassword("");
    setNewAdminPasswordConfirm("");
    setExistingSudoPassword("");
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
  const requiredRuntimes = requiredQuickSetupRuntimes(draft);
  const forwardBlocked = Boolean(usernameError || portError);
  const noDraftStorage = quickSetupDraftKey(profile.id) === null;
  const firewallPlan = resolveQuickSetupFirewallPlan(draft, profile.port);
  const newPasswordTooLong =
    passwordBytes(newAdminPassword) > quickSetupPasswordByteLimit;
  const confirmationTooLong =
    passwordBytes(newAdminPasswordConfirm) > quickSetupPasswordByteLimit;
  const existingPasswordTooLong =
    passwordBytes(existingSudoPassword) > quickSetupPasswordByteLimit;
  const passwordMismatch =
    newAdminPasswordConfirm.length > 0 &&
    newAdminPassword !== newAdminPasswordConfirm;

  let stepContent: ReactNode;
  if (draft.step === 1) {
    stepContent = (
      <StepSection
        step={1}
        title="Connect and inspect"
        description="Review the saved profile, then open the inspection view when you are ready. Nothing connects automatically."
      >
        <dl className="divide-y divide-border/70 border-y border-border/70">
          <DetailRow label="Profile">{profile.name}</DetailRow>
          <DetailRow label="Address">
            {profile.username}@{profile.host}:{profile.port}
          </DetailRow>
          <DetailRow label="Connection">
            {connected ? "Connected" : "Disconnected"}
          </DetailRow>
          <DetailRow label="Saved key">
            {profile.identityFile || "SSH agent / default keys"}
          </DetailRow>
        </dl>
        <Button type="button" variant="outline" onClick={onOpenInspection}>
          Open server inspection
        </Button>
      </StepSection>
    );
  } else if (draft.step === 2) {
    stepContent = (
      <StepSection
        step={2}
        title="Administrator"
        description="Choose a separate account or an existing administrator. Sudo access is not verified."
      >
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
              description={
                mode === "new"
                  ? "A separate sudo-capable account."
                  : "An existing account with unknown privileges."
              }
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
        <div className="space-y-4 border-t border-border/70 pt-4">
          {draft.administrator.mode === "new" ? (
            <div className="max-w-sm space-y-4">
              <div className="space-y-1.5">
                <label
                  htmlFor={`${fieldPrefix}-new-password`}
                  className="block text-sm"
                >
                  New administrator password
                </label>
                <Input
                  id={`${fieldPrefix}-new-password`}
                  type="password"
                  autoComplete="new-password"
                  maxLength={quickSetupPasswordByteLimit}
                  value={newAdminPassword}
                  aria-invalid={newPasswordTooLong}
                  aria-describedby={
                    newPasswordTooLong
                      ? `${fieldPrefix}-new-password-error`
                      : undefined
                  }
                  onChange={(event) => setNewAdminPassword(event.target.value)}
                />
                {newPasswordTooLong && (
                  <p
                    id={`${fieldPrefix}-new-password-error`}
                    role="alert"
                    className="text-xs text-destructive"
                  >
                    Use at most {quickSetupPasswordByteLimit} bytes.
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <label
                  htmlFor={`${fieldPrefix}-new-password-confirm`}
                  className="block text-sm"
                >
                  Confirm administrator password
                </label>
                <Input
                  id={`${fieldPrefix}-new-password-confirm`}
                  type="password"
                  autoComplete="new-password"
                  maxLength={quickSetupPasswordByteLimit}
                  value={newAdminPasswordConfirm}
                  aria-invalid={confirmationTooLong || passwordMismatch}
                  aria-describedby={
                    confirmationTooLong
                      ? `${fieldPrefix}-new-password-confirm-error`
                      : passwordMismatch
                        ? `${fieldPrefix}-new-password-mismatch`
                        : undefined
                  }
                  onChange={(event) =>
                    setNewAdminPasswordConfirm(event.target.value)
                  }
                />
                {confirmationTooLong && (
                  <p
                    id={`${fieldPrefix}-new-password-confirm-error`}
                    role="alert"
                    className="text-xs text-destructive"
                  >
                    Use at most {quickSetupPasswordByteLimit} bytes.
                  </p>
                )}
              </div>
              {passwordMismatch && (
                <p
                  id={`${fieldPrefix}-new-password-mismatch`}
                  role="alert"
                  className="text-xs text-destructive"
                >
                  Passwords do not match.
                </p>
              )}
              <p className="text-xs leading-relaxed text-muted-foreground">
                This password is planned for the new local account and its sudo
                access. SSH password login is a separate setting. Account
                creation and sudo verification are unavailable today.
              </p>
            </div>
          ) : (
            <div className="max-w-sm space-y-1.5">
              <label
                htmlFor={`${fieldPrefix}-sudo-password`}
                className="block text-sm"
              >
                Existing administrator sudo password
              </label>
              <Input
                id={`${fieldPrefix}-sudo-password`}
                type="password"
                autoComplete="current-password"
                maxLength={quickSetupPasswordByteLimit}
                value={existingSudoPassword}
                aria-invalid={existingPasswordTooLong}
                aria-describedby={
                  existingPasswordTooLong
                    ? `${fieldPrefix}-sudo-password-error`
                    : undefined
                }
                onChange={(event) =>
                  setExistingSudoPassword(event.target.value)
                }
              />
              {existingPasswordTooLong && (
                <p
                  id={`${fieldPrefix}-sudo-password-error`}
                  role="alert"
                  className="text-xs text-destructive"
                >
                  Use at most {quickSetupPasswordByteLimit} bytes.
                </p>
              )}
              <p className="text-xs leading-relaxed text-muted-foreground">
                This password is planned for sudo only. It does not reset or
                change the account password. Account actions and sudo
                verification are unavailable today.
              </p>
            </div>
          )}
          <p className="text-xs leading-relaxed text-muted-foreground">
            Secrets stay only while this step is open. They are not saved, sent,
            verified or reused, and must be reentered when applying becomes
            available.
          </p>
        </div>
      </StepSection>
    );
  } else if (draft.step === 3) {
    stepContent = (
      <StepSection
        step={3}
        title="SSH key"
        description="Choose how you will sign in."
      >
        <ChoiceGroup label="SSH key strategy">
          {(["existing", "generate", "agent"] as const).map((strategy) => (
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
                description={keyStrategyDescriptions[strategy]}
              />
              <ExpandableExplanation label="What this means">
                {keyStrategyExplanations[strategy]}
              </ExpandableExplanation>
            </div>
          ))}
        </ChoiceGroup>
        {(draft.sshKey.strategy === "existing" ||
          draft.sshKey.strategy === "generate") && (
          <QuickSetupKeyManager
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
            }}
            connectionId={connectionId}
            connected={connected}
            target={{
              username: draft.administrator.username,
              port: draft.access.port,
            }}
          />
        )}
      </StepSection>
    );
  } else if (draft.step === 4) {
    stepContent = (
      <StepSection
        step={4}
        title="SSH and firewall"
        description="Choose the target port and firewall plan. Neither proves provider or recovery readiness."
      >
        <div className="max-w-40 space-y-1.5">
          <label htmlFor={`${fieldPrefix}-port`} className="block text-sm">
            Target SSH port
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
        <p className="text-xs leading-relaxed text-muted-foreground">
          High ports such as 52,022 are suggestions only. Check collisions and
          ephemeral ranges on the server.
        </p>
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
                  ? "Plan an allow rule before restrictive policy."
                  : "Make no UFW plan; provider rules remain unknown."
              }
            />
          ))}
        </ChoiceGroup>
        <div className="divide-y divide-border/70 border-y border-border/70">
          <CheckRow
            id={`${fieldPrefix}-recovery-acknowledged`}
            label="I understand that provider firewall access, IPv4/IPv6 reachability and out-of-band recovery readiness are unverified."
            checked={draft.access.recoveryAcknowledged}
            onToggle={() =>
              update((current) => ({
                ...current,
                access: {
                  ...current.access,
                  recoveryAcknowledged: !current.access.recoveryAcknowledged,
                },
              }))
            }
          />
        </div>
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
      <StepSection
        step={5}
        title="Application stack"
        description="Choose what to install. Existing workloads are not inspected."
      >
        <ChoiceGroup label="Application stack">
          {(["dokploy", "javascript", "containers", "skip"] as const).map(
            (choice) => (
              <ChoiceRow
                key={choice}
                selected={draft.stack.choice === choice}
                onClick={() => chooseStack(choice)}
                label={stackLabels[choice]}
                description={stackDescriptions[choice]}
              />
            ),
          )}
        </ChoiceGroup>
        {draft.stack.choice !== "dokploy" && draft.stack.choice !== "skip" && (
          <div className="space-y-2">
            <p className="text-sm font-medium">Container engine (optional)</p>
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
                      <span className="min-w-0 text-sm">{option.label}</span>
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
      <StepSection
        step={6}
        title="Developer tools"
        description="Choose the editor and utilities to plan. Existing configuration is preserved."
      >
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
                  description={editorDescriptions[editor]}
                />
                <PlannedSourceDisclosure
                  entryId={
                    editor === "none"
                      ? ""
                      : editor === "lazyvim"
                        ? "lazyvim-starter"
                        : editor
                  }
                  className="px-2"
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
                  hint={
                    id === "herdr"
                      ? quickSetupHerdr.reason
                      : quickSetupCatalog[id].description
                  }
                  checked={draft.tools.utilities.includes(id)}
                  onToggle={() => toggleUtility(id)}
                />
                <PlannedSourceDisclosure entryId={id} />
              </div>
            ))}
          </div>
        </div>
      </StepSection>
    );
  } else if (draft.step === 7) {
    stepContent = (
      <StepSection
        step={7}
        title="Runtimes"
        description="Choose user-scoped runtimes. Required dependencies are included once."
      >
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
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  {group.description}
                </p>
                <div className="mt-1 divide-y divide-border/70">
                  {group.runtimes.map((id) => {
                    const required = requiredRuntimes.includes(id);
                    const selected = required || draft.runtimes.includes(id);
                    return (
                      <CheckRow
                        key={id}
                        id={`${fieldPrefix}-runtime-${id}`}
                        label={quickSetupCatalog[id].label}
                        hint={quickSetupCatalog[id].description}
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
        {draft.stack.choice === "javascript" && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            NVM + Node.js is required by JavaScript / PM2 and is included once.
          </p>
        )}
        {draft.tools.editor === "lazyvim" && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            LazyVim adds Git, ripgrep and fd once.
          </p>
        )}
      </StepSection>
    );
  } else {
    stepContent = (
      <StepSection
        step={8}
        title="Review and finish"
        description="Saved choices for this server. Server provisioning has not been applied."
      >
        <section aria-labelledby={`${fieldPrefix}-review-access`}>
          <h3
            id={`${fieldPrefix}-review-access`}
            className="text-sm font-medium"
          >
            Access
          </h3>
          <dl className="divide-y divide-border/70 border-y border-border/70">
            <DetailRow label="Target">
              {profile.name} · {profile.username}@{profile.host}:{profile.port}
            </DetailRow>
            <DetailRow label="Connection">
              {connected ? "Connected" : "Disconnected"}
            </DetailRow>
            <DetailRow label="Administrator">
              {draft.administrator.username} ·{" "}
              {adminModeLabels[draft.administrator.mode]}
            </DetailRow>
            <DetailRow label="SSH key">{keySelectionSummary(draft)}</DetailRow>
            <DetailRow label="SSH port">{draft.access.port}</DetailRow>
            <DetailRow label="Firewall">
              {ufwLabels[draft.access.ufw]}
            </DetailRow>
            <DetailRow label="Planned rules">
              {firewallPlan.apply
                ? firewallPlan.rules.length
                  ? firewallPlan.rules
                      .map(
                        (rule) =>
                          `${rule.port}/${rule.protocol}${rule.protected ? " (protected)" : ""}`,
                      )
                      .join(", ")
                  : "None"
                : "No planned changes · choices retained"}
            </DetailRow>
            <DetailRow label="Rule sources">
              {firewallPlan.apply ? "Any IPv4/IPv6 (planned)" : "Not planned"}
            </DetailRow>
            <DetailRow label="Default policy">
              {firewallPlan.apply
                ? "Inbound deny · outbound allow"
                : "Current policy retained"}
            </DetailRow>
            <DetailRow label="Recovery">
              {draft.access.recoveryAcknowledged
                ? "Acknowledged · not a verified recovery check"
                : "Not acknowledged"}
            </DetailRow>
          </dl>
        </section>
        <section aria-labelledby={`${fieldPrefix}-review-application`}>
          <h3
            id={`${fieldPrefix}-review-application`}
            className="text-sm font-medium"
          >
            Application
          </h3>
          <dl className="divide-y divide-border/70 border-y border-border/70">
            <DetailRow label="Stack">
              {stackLabels[draft.stack.choice]}
            </DetailRow>
            <DetailRow label="Container engine">
              {draft.stack.engine
                ? quickSetupCatalogLabel(draft.stack.engine)
                : "None"}
            </DetailRow>
          </dl>
        </section>
        <section aria-labelledby={`${fieldPrefix}-review-tools`}>
          <h3
            id={`${fieldPrefix}-review-tools`}
            className="text-sm font-medium"
          >
            Tools
          </h3>
          <dl className="divide-y divide-border/70 border-y border-border/70">
            <DetailRow label="Editor">
              {editorLabels[draft.tools.editor]}
            </DetailRow>
            <DetailRow label="Utilities">
              {draft.tools.utilities.length
                ? draft.tools.utilities
                    .map((id) => quickSetupCatalogLabel(id))
                    .join(", ")
                : "None"}
            </DetailRow>
            <DetailRow label="Runtimes">
              {draft.runtimes.length
                ? draft.runtimes
                    .map((id) => quickSetupCatalogLabel(id))
                    .join(", ")
                : "None"}
            </DetailRow>
          </dl>
        </section>
        <QuickSetupResolvedSources items={plan.items} />
        {plan.missing.map((message) => (
          <p key={message} role="status" className="text-xs text-warning">
            {message}
          </p>
        ))}
        <p
          role="status"
          className="text-sm leading-relaxed text-muted-foreground"
        >
          Server changes remain unavailable. SSH and UFW hardening has not been
          applied; key login verification is a separate test.
        </p>
      </StepSection>
    );
  }

  return (
    <section
      ref={page}
      aria-label="Quick Setup"
      className="mx-auto w-full max-w-[1000px] space-y-7"
    >
      <QuickSetupHeader step={draft.step} />
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
          {stepContent}
          <TechnicalDetails />
          <footer className="flex items-center justify-between gap-3 border-t border-border/70 pt-4">
            <Button
              type="button"
              variant="ghost"
              disabled={draft.step === 1}
              onClick={() => changeStep((draft.step - 1) as QuickSetupStepId)}
            >
              Back
            </Button>
            {draft.step === 8 ? (
              <p className="text-xs text-muted-foreground">
                Saved preview only.
              </p>
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
      </div>
    </section>
  );
}

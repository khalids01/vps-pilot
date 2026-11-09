import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { desktopAvailable, safeError } from "./api";
import { QuickSetupAccess } from "./quick-setup-access";
import { type AdminStage, QuickSetupAdmin } from "./quick-setup-admin";
import {
  defaultQuickSetupKeyName,
  quickSetupKeyNameMaxLength,
  validateQuickSetupKeyName,
} from "./quick-setup-model";

export type KeyLocation = "ssh" | "legacy" | "external";

export interface SetupKey {
  keyId: string;
  fingerprint: string;
  algorithm: string;
  encrypted: boolean;
  path: string;
  location: KeyLocation;
}
interface SetupKeyIssue {
  keyId: string | null;
  reason: string;
}
interface SetupKeyList {
  keys: SetupKey[];
  issues: SetupKeyIssue[];
  storagePath: string;
  legacyStoragePath: string;
  truncated: boolean;
}
interface ExportResult {
  status: "exported" | "canceled";
  path: string | null;
  encrypted: boolean;
}
interface CopyResult {
  status: "copied" | "already";
  key: SetupKey;
}
interface SelectResult {
  status: "selected" | "canceled";
  key: SetupKey | null;
}
interface KeyNameCheck {
  fileName: string;
  available: boolean;
  message: string;
}

type KeyMutation = "load" | "create" | "select" | "copy" | "export";

function passphraseBytes(value: string) {
  return new TextEncoder().encode(value).length;
}

function locationLabel(location: KeyLocation) {
  if (location === "ssh") return "Stored in ~/.ssh";
  if (location === "legacy") return "App vault";
  return "Original file outside ~/.ssh";
}

export function QuickSetupKeyManager({
  visible = true,
  strategy,
  selectedKeyId,
  onSelectKey,
  source,
  plannedTarget,
  adminMode,
  adminUsername,
  plannedPort,
  connectionId,
  connected,
  onOpenProfile,
}: {
  visible?: boolean;
  strategy: "existing" | "generate";
  selectedKeyId?: string;
  onSelectKey: (keyId: string) => void;
  source: {
    profileId: string;
    profileRevision: string;
    host: string;
    username: string;
    port: number;
  };
  plannedTarget: { username: string; port: number };
  adminMode: "new" | "existing";
  adminUsername: string;
  plannedPort: number;
  connectionId?: string | null;
  connected: boolean;
  onOpenProfile: (profileId: string) => void;
}) {
  const id = useId();
  const [keys, setKeys] = useState<SetupKeyList | null>(null);
  const [listError, setListError] = useState("");
  const [loading, setLoading] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  useEffect(() => {
    if (!visible) {
      setPassphrase("");
      setConfirmation("");
    }
  }, [visible]);
  const [fileName, setFileName] = useState(() =>
    defaultQuickSetupKeyName(source.host),
  );
  const [fileNameError, setFileNameError] = useState("");
  const [nameCheck, setNameCheck] = useState<KeyNameCheck | null>(null);
  const [nameChecking, setNameChecking] = useState(false);
  const [keyRevision, setKeyRevision] = useState(0);
  const [mutation, setMutation] = useState<KeyMutation | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [copying, setCopying] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [storedOpen, setStoredOpen] = useState(false);
  const [storageOpen, setStorageOpen] = useState(false);
  const [accessBusy, setAccessBusy] = useState(false);
  const [adminStage, setAdminStage] = useState<AdminStage>("pending");
  const [adminBusy, setAdminBusy] = useState(false);
  const [accessState, setAccessState] = useState<{
    installedFor: string | null;
    verified: boolean;
  }>({ installedFor: null, verified: false });
  const handleAccessState = useCallback(
    (state: { installedFor: string | null; verified: boolean }) => {
      setAccessState(state);
    },
    [],
  );
  const needsAdministrator =
    source.username === "root" && plannedTarget.username !== "root";
  const adminTarget = needsAdministrator ? plannedTarget.username : null;
  const active = useRef(true);
  const accessBusyRef = useRef(false);
  const mutationGate = useRef<KeyMutation | null>(null);
  const strategyRef = useRef(strategy);
  strategyRef.current = strategy;
  const fileNameRef = useRef(fileName);
  fileNameRef.current = fileName;
  const createRequest = useRef(0);
  const selectRequest = useRef(0);
  const copyRequest = useRef(0);
  const exportRequest = useRef(0);
  const loadRequest = useRef(0);
  const nameRequest = useRef(0);
  const nameTimer = useRef<number | null>(null);

  const handleAccessBusy = useCallback((busy: boolean) => {
    accessBusyRef.current = busy;
    setAccessBusy(busy);
  }, []);
  const handleAdminBusy = useCallback((busy: boolean) => {
    setAdminBusy(busy);
  }, []);

  const load = useCallback(async () => {
    if (!desktopAvailable) {
      setListError("Local SSH keys are available only in the desktop app.");
      return;
    }
    // One mutation at a time; a reload never queues behind generation,
    // selection, export, or an active key-login operation.
    if (mutationGate.current || accessBusyRef.current) return;
    mutationGate.current = "load";
    if (active.current) {
      setMutation("load");
      setLoading(true);
      setListError("");
    }
    const token = ++loadRequest.current;
    try {
      const result = await invoke<SetupKeyList>("app_setup_keys_list");
      if (!active.current || token !== loadRequest.current) return;
      setKeys(result);
      setKeyRevision((value) => value + 1);
    } catch (failure) {
      if (!active.current || token !== loadRequest.current) return;
      setListError(
        `${safeError(failure)} Stored keys were not listed; existing entries are preserved.`,
      );
      setKeyRevision((value) => value + 1);
    } finally {
      if (token === loadRequest.current) {
        mutationGate.current = null;
        if (active.current) {
          setMutation(null);
          setLoading(false);
        }
      }
    }
  }, []);

  useEffect(() => {
    active.current = true;
    let canceled = false;
    // Defer the first load by a microtask so a StrictMode mount/cleanup/mount
    // cycle cancels the discarded run before it ever acquires the gate.
    queueMicrotask(() => {
      if (!canceled && active.current) void load();
    });
    return () => {
      // Invalidate every in-flight reply without setting state after unmount.
      canceled = true;
      active.current = false;
      createRequest.current += 1;
      selectRequest.current += 1;
      copyRequest.current += 1;
      exportRequest.current += 1;
      loadRequest.current += 1;
      nameRequest.current += 1;
      if (nameTimer.current !== null) {
        window.clearTimeout(nameTimer.current);
        nameTimer.current = null;
      }
      // Release only the load gate from this effect run. A user mutation's
      // worker owns its own gate; a stale reply can never release a newer one.
      if (mutationGate.current === "load") mutationGate.current = null;
    };
  }, [load]);

  const checkName = useCallback(async (name: string, token: number) => {
    if (!active.current || token !== nameRequest.current) return;
    try {
      const result = await invoke<KeyNameCheck>("app_setup_key_check_name", {
        fileName: name,
      });
      if (
        !active.current ||
        token !== nameRequest.current ||
        fileNameRef.current !== name
      )
        return;
      setNameCheck(result);
      setFileNameError(result.available ? "" : result.message);
    } catch (failure) {
      if (
        !active.current ||
        token !== nameRequest.current ||
        fileNameRef.current !== name
      )
        return;
      setNameCheck(null);
      setFileNameError(safeError(failure));
    } finally {
      if (active.current && token === nameRequest.current)
        setNameChecking(false);
    }
  }, []);

  const selectedKey =
    keys?.keys.find((key) => key.keyId === selectedKeyId) ?? null;
  const targetAccount = needsAdministrator
    ? plannedTarget.username
    : source.username;
  const accountReady = adminStage !== "pending";
  const installDone = needsAdministrator
    ? accessState.installedFor === targetAccount ||
      ["key-installed", "verified", "promoted"].includes(adminStage)
    : accessState.installedFor === targetAccount || accessState.verified;
  const nameFormVisible =
    strategy === "generate" && (!selectedKey || createOpen);
  useEffect(() => {
    // These are intentional freshness triggers: a reload must not reuse an
    // earlier availability answer even when the filename text is unchanged.
    void keyRevision;
    void keys;
    nameRequest.current += 1;
    const token = nameRequest.current;
    if (nameTimer.current !== null) {
      window.clearTimeout(nameTimer.current);
      nameTimer.current = null;
    }
    setNameCheck(null);
    if (!nameFormVisible) {
      setFileNameError("");
      setNameChecking(false);
      return;
    }
    const immediate = validateQuickSetupKeyName(fileName);
    setFileNameError(immediate ?? "");
    if (immediate !== null || !desktopAvailable) {
      setNameChecking(false);
      return;
    }
    setNameChecking(true);
    nameTimer.current = window.setTimeout(() => {
      nameTimer.current = null;
      void checkName(fileName, token);
    }, 250);
    return () => {
      if (nameTimer.current !== null) {
        window.clearTimeout(nameTimer.current);
        nameTimer.current = null;
      }
    };
    // A fresh inventory or form opening must not reuse an availability answer
    // that was produced before a key was created, copied, or selected.
  }, [fileName, nameFormVisible, keyRevision, keys, checkName]);

  const measured = passphraseBytes(passphrase);
  const passphraseError =
    measured === 0
      ? ""
      : measured < 12
        ? "Use at least 12 bytes."
        : measured > 4096
          ? "Use at most 4096 bytes."
          : "";
  const confirmationError =
    confirmation.length > 0 && confirmation !== passphrase
      ? "The passphrases do not match."
      : "";
  const nameReady =
    nameCheck !== null &&
    nameCheck.fileName === fileName &&
    nameCheck.available;
  const canCreate =
    strategy === "generate" &&
    desktopAvailable &&
    keys !== null &&
    listError.length === 0 &&
    mutation === null &&
    !accessBusy &&
    fileNameError.length === 0 &&
    nameReady &&
    passphraseError.length === 0 &&
    confirmation === passphrase;

  async function createKey() {
    if (!canCreate || mutationGate.current || accessBusyRef.current) return;
    const name = fileName;
    const secret = passphrase;
    // Clear the transient values before awaiting so no passphrase lingers in
    // component state while the native worker runs.
    setPassphrase("");
    setConfirmation("");
    // The availability answer used to enable this attempt is now stale; a
    // racing file must be rechecked after the inventory reloads.
    setNameCheck(null);
    setFileNameError("");
    nameRequest.current += 1;
    const token = ++createRequest.current;
    const startingStrategy = strategy;
    mutationGate.current = "create";
    setMutation("create");
    setError("");
    setNotice("");
    let refresh = false;
    try {
      const key = await invoke<SetupKey>("app_setup_key_generate", {
        fileName: name,
        passphrase: secret,
      });
      if (!active.current || token !== createRequest.current) return;
      if (strategyRef.current !== startingStrategy) {
        refresh = true;
        return;
      }
      onSelectKey(key.keyId);
      setCreateOpen(false);
      setFileNameError("");
      setNotice(
        key.encrypted
          ? "Encrypted key created in ~/.ssh."
          : "Key created in ~/.ssh without a passphrase.",
      );
      refresh = true;
    } catch (failure) {
      if (!active.current || token !== createRequest.current) return;
      const message = safeError(failure);
      const collision =
        /already uses this key name|already use its name|file or folder already uses this key/i.test(
          message,
        );
      // A native failure may still have published part of the pair. Never claim
      // that nothing was created; reload metadata and report uncertainty.
      if (collision) {
        setFileNameError(message);
        setNotice(
          "Existing files were not overwritten. Reload local keys to check whether any part of this key pair was published; nothing was retried.",
        );
      } else {
        setError(
          `${message} The existing key selection was preserved. Reload local keys to check whether a key or part of its pair was published; nothing was retried.`,
        );
      }
      refresh = true;
    } finally {
      if (token === createRequest.current) {
        mutationGate.current = null;
        if (active.current) setMutation(null);
      }
    }
    if (refresh && active.current) void load();
  }

  async function choosePrivateKey() {
    if (!desktopAvailable || mutationGate.current || accessBusyRef.current)
      return;
    setPassphrase("");
    setConfirmation("");
    const token = ++selectRequest.current;
    const startingStrategy = strategy;
    mutationGate.current = "select";
    setMutation("select");
    setError("");
    setNotice("");
    let refresh = false;
    try {
      const result = await invoke<SelectResult>("app_setup_key_select");
      if (!active.current || token !== selectRequest.current) return;
      if (result.status === "canceled") {
        setNotice("No key was chosen. The previous selection was kept.");
        return;
      }
      if (!result.key) {
        setError(
          "The native picker did not return a usable key. The previous selection was kept.",
        );
        return;
      }
      if (strategyRef.current !== startingStrategy) return;
      onSelectKey(result.key.keyId);
      setNotice(
        result.key.encrypted
          ? "Encrypted private key selected."
          : "Private key selected without a passphrase.",
      );
      refresh = true;
    } catch (failure) {
      if (!active.current || token !== selectRequest.current) return;
      setError(`${safeError(failure)} The previous selection was kept.`);
    } finally {
      if (token === selectRequest.current) {
        mutationGate.current = null;
        if (active.current) setMutation(null);
      }
    }
    if (refresh && active.current) void load();
  }

  async function copyToSsh(keyId: string) {
    if (!desktopAvailable || mutationGate.current || accessBusyRef.current)
      return;
    setPassphrase("");
    setConfirmation("");
    const token = ++copyRequest.current;
    mutationGate.current = "copy";
    setMutation("copy");
    setCopying(keyId);
    setError("");
    setNotice("");
    let refresh = false;
    try {
      const result = await invoke<CopyResult>(
        "app_setup_key_use_ssh_directory",
        { keyId },
      );
      if (!active.current || token !== copyRequest.current) return;
      setNotice(
        result.status === "already"
          ? "This key is already in ~/.ssh."
          : "Key copied to ~/.ssh. The app vault copy was kept.",
      );
      refresh = true;
    } catch (failure) {
      if (!active.current || token !== copyRequest.current) return;
      setError(
        `${safeError(failure)} The local key and its selection were preserved. Reload local keys to check whether a copy was published; nothing was retried.`,
      );
      refresh = true;
    } finally {
      if (token === copyRequest.current) {
        mutationGate.current = null;
        if (active.current) {
          setMutation(null);
          setCopying(null);
        }
      }
    }
    if (refresh && active.current) void load();
  }

  async function backup(keyId: string) {
    if (!desktopAvailable || mutationGate.current || accessBusyRef.current)
      return;
    setPassphrase("");
    setConfirmation("");
    const token = ++exportRequest.current;
    mutationGate.current = "export";
    setMutation("export");
    setExporting(keyId);
    setError("");
    setNotice("");
    try {
      const result = await invoke<ExportResult>("app_setup_key_export", {
        keyId,
      });
      if (!active.current || token !== exportRequest.current) return;
      if (result.status === "canceled") {
        setNotice(
          result.encrypted
            ? "Backup canceled. The encrypted key was not copied."
            : "Backup canceled. The key was not copied.",
        );
      } else {
        setNotice(
          `${
            result.encrypted ? "Encrypted key" : "Key without a passphrase"
          } copied to ${
            result.path ?? "the chosen destination"
          }. The local key was not changed.`,
        );
      }
    } catch (failure) {
      if (!active.current || token !== exportRequest.current) return;
      setError(
        `${safeError(failure)} The local key and its selection were preserved.`,
      );
    } finally {
      if (token === exportRequest.current) {
        mutationGate.current = null;
        if (active.current) {
          setMutation(null);
          setExporting(null);
        }
      }
    }
  }

  function selectStoredKey(keyId: string) {
    if (mutationGate.current || accessBusyRef.current) return;
    onSelectKey(keyId);
    setStoredOpen(false);
  }

  const selectedMissing =
    Boolean(selectedKeyId) &&
    Boolean(keys) &&
    selectedKey === null &&
    !loading &&
    mutation === null &&
    !accessBusy;
  const issueReasons = [...new Set(keys?.issues.map((issue) => issue.reason))];
  const otherKeys =
    keys?.keys.filter((key) => key.keyId !== selectedKeyId) ?? [];
  const showCreateForm = nameFormVisible;
  const namePreview = fileName || "name";

  const createForm = (
    <fieldset id={`${id}-create`} className="space-y-3 border-0 p-0">
      <legend className="text-sm font-medium">Create a local key</legend>
      <div className="space-y-1.5">
        <label htmlFor={`${id}-name`} className="block text-sm">
          Key filename
        </label>
        <Input
          id={`${id}-name`}
          type="text"
          autoComplete="off"
          spellCheck={false}
          maxLength={quickSetupKeyNameMaxLength}
          value={fileName}
          disabled={mutation !== null || accessBusy}
          aria-invalid={Boolean(fileNameError)}
          aria-describedby={
            fileNameError ? `${id}-name-error` : `${id}-name-preview`
          }
          onChange={(event) => setFileName(event.target.value)}
        />
        <p
          id={`${id}-name-preview`}
          className="break-all text-xs text-muted-foreground"
        >
          ~/.ssh/{namePreview} and ~/.ssh/{namePreview}.pub
        </p>
        {fileNameError && (
          <p
            id={`${id}-name-error`}
            role="alert"
            className="text-xs leading-relaxed text-destructive"
          >
            {fileNameError}
          </p>
        )}
        {!fileNameError && nameReady && nameCheck && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {nameCheck.message}
          </p>
        )}
        {!fileNameError && nameChecking && !nameReady && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Checking that this name is available…
          </p>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor={`${id}-passphrase`} className="block text-sm">
            Passphrase (optional)
          </label>
          <Input
            id={`${id}-passphrase`}
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={passphrase}
            disabled={mutation !== null || accessBusy}
            aria-invalid={Boolean(passphraseError)}
            aria-describedby={
              passphraseError ? `${id}-passphrase-error` : undefined
            }
            onChange={(event) => setPassphrase(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor={`${id}-confirmation`} className="block text-sm">
            Confirm passphrase (optional)
          </label>
          <Input
            id={`${id}-confirmation`}
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={confirmation}
            disabled={mutation !== null || accessBusy}
            aria-invalid={Boolean(confirmationError)}
            aria-describedby={
              confirmationError ? `${id}-confirmation-error` : undefined
            }
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </div>
      </div>
      {passphraseError && (
        <p
          id={`${id}-passphrase-error`}
          role="alert"
          className="text-xs text-destructive"
        >
          {passphraseError}
        </p>
      )}
      {confirmationError && (
        <p
          id={`${id}-confirmation-error`}
          role="alert"
          className="text-xs text-destructive"
        >
          {confirmationError}
        </p>
      )}
      <Button
        type="button"
        variant={selectedKey ? "outline" : "default"}
        disabled={!canCreate}
        onClick={() => void createKey()}
      >
        {mutation === "create"
          ? "Creating key…"
          : measured > 0
            ? "Create encrypted key"
            : "Create key without passphrase"}
      </Button>
    </fieldset>
  );

  const accessSection =
    selectedKey &&
    selectedKey.location !== "legacy" &&
    (!needsAdministrator || accountReady) ? (
      <QuickSetupAccess
        visible={visible}
        source={source}
        plannedTarget={plannedTarget}
        targetUsername={adminTarget}
        connectionId={connectionId}
        connected={connected}
        selectedKey={selectedKey}
        keyBusy={
          mutation !== null ||
          adminBusy ||
          (needsAdministrator && adminStage === "pending")
        }
        onBusyChange={handleAccessBusy}
        onStateChange={handleAccessState}
      />
    ) : null;

  return (
    <div className="space-y-4 border-t border-border/70 pt-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-medium">Local SSH key</h3>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={mutation !== null || accessBusy}
          onClick={() => void load()}
        >
          {loading ? "Loading keys…" : "Reload keys"}
        </Button>
      </div>

      {strategy === "existing" && (
        <div className="space-y-2">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Select a key from this device.
          </p>
          <Button
            type="button"
            variant={selectedKey ? "outline" : "default"}
            disabled={mutation !== null || accessBusy}
            onClick={() => void choosePrivateKey()}
          >
            {mutation === "select"
              ? "Choosing private key…"
              : selectedKey
                ? "Choose a different private key"
                : "Choose private key"}
          </Button>
        </div>
      )}

      {selectedKey && (
        <fieldset className="min-w-0 border-0 p-0">
          <legend className="sr-only">Selected local key</legend>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Selected key</p>
              <p className="mt-1 break-all text-sm">
                {selectedKey.fingerprint}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {selectedKey.algorithm} ·{" "}
                {selectedKey.encrypted ? "Encrypted" : "No passphrase"} ·{" "}
                {locationLabel(selectedKey.location)}
              </p>
              <p className="mt-1 break-all text-xs text-muted-foreground">
                {selectedKey.path}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {strategy === "existing" && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={mutation !== null || accessBusy}
                  onClick={() => void choosePrivateKey()}
                >
                  {mutation === "select"
                    ? "Choosing private key…"
                    : "Choose key file"}
                </Button>
              )}
              {strategy === "generate" && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-expanded={createOpen}
                  aria-controls={`${id}-create`}
                  disabled={mutation !== null || accessBusy}
                  onClick={() => setCreateOpen((value) => !value)}
                >
                  {createOpen ? "Hide new key form" : "Create another key"}
                </Button>
              )}
              {selectedKey.location === "legacy" && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={mutation !== null || accessBusy}
                  onClick={() => void copyToSsh(selectedKey.keyId)}
                >
                  {copying === selectedKey.keyId
                    ? "Copying key…"
                    : "Put in ~/.ssh"}
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                disabled={mutation !== null || accessBusy}
                onClick={() => void backup(selectedKey.keyId)}
              >
                {exporting === selectedKey.keyId
                  ? "Saving backup…"
                  : selectedKey.encrypted
                    ? "Backup encrypted key"
                    : "Backup key without passphrase"}
              </Button>
            </div>
          </div>
          {selectedKey.location === "legacy" && (
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              This key is in the app vault. Put it in ~/.ssh before verifying
              key login; the app vault copy is kept.
            </p>
          )}
          {selectedKey.location === "external" && (
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              External key file.
            </p>
          )}
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {selectedKey.encrypted ? "Encrypted key" : "No passphrase"}
          </p>
        </fieldset>
      )}

      {selectedKey &&
        selectedKey.location !== "legacy" &&
        connected &&
        needsAdministrator && (
          <QuickSetupAdmin
            visible={visible}
            source={source}
            mode={adminMode}
            username={adminUsername}
            plannedPort={plannedPort}
            connectionId={connectionId}
            connected={connected}
            selectedKey={selectedKey}
            keyBusy={mutation !== null || accessBusy}
            keyInstalled={installDone}
            keyInstallation={accessSection}
            onBusyChange={handleAdminBusy}
            onStageChange={setAdminStage}
            onOpenProfile={onOpenProfile}
          />
        )}

      {!needsAdministrator && accessSection}

      {showCreateForm && createForm}

      {strategy === "generate" && !selectedKey && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={mutation !== null || accessBusy}
          onClick={() => void choosePrivateKey()}
          className="-ml-2.5 text-muted-foreground"
        >
          {mutation === "select"
            ? "Choosing private key…"
            : "Choose an existing private key instead"}
        </Button>
      )}

      {error && (
        <p
          role="alert"
          aria-label="Key operation error"
          className="text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {notice && (
        <p
          role="status"
          aria-label="Key activity"
          className="text-sm text-muted-foreground"
        >
          {notice}
        </p>
      )}
      {listError && (
        <div className="space-y-2">
          <p
            role="alert"
            aria-label="Local key list error"
            className="text-sm text-destructive"
          >
            {listError}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void load()}
          >
            Retry key list
          </Button>
        </div>
      )}
      {selectedMissing && (
        <p role="status" className="text-sm text-warning">
          The saved key reference is not available in this local vault. The
          reference was preserved; choose another key or reload the list.
        </p>
      )}

      {otherKeys.length > 0 && (
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={storedOpen}
            onClick={() => setStoredOpen((value) => !value)}
            className="-ml-2.5 text-muted-foreground"
          >
            Choose a stored key
          </Button>
          {storedOpen && (
            <ul
              aria-label="Stored local keys"
              className="mt-1 divide-y divide-border/70 border-y border-border/70"
            >
              {otherKeys.map((key) => (
                <li
                  key={key.keyId}
                  className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="break-all text-sm">{key.fingerprint}</p>
                    <p className="text-xs text-muted-foreground">
                      {key.algorithm} ·{" "}
                      {key.encrypted ? "Encrypted" : "No passphrase"} ·{" "}
                      {locationLabel(key.location)}
                    </p>
                    <p className="break-all text-xs text-muted-foreground">
                      {key.path}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {key.location === "legacy" && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-label={`Put key ${key.fingerprint} in ~/.ssh`}
                        disabled={mutation !== null || accessBusy}
                        onClick={() => void copyToSsh(key.keyId)}
                      >
                        {copying === key.keyId
                          ? "Copying key…"
                          : "Put in ~/.ssh"}
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-label={`Select key ${key.fingerprint}`}
                      disabled={mutation !== null || accessBusy}
                      onClick={() => selectStoredKey(key.keyId)}
                    >
                      Use key
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {keys && keys.keys.length === 0 && !keys.issues.length && !listError && (
        <p role="status" className="text-sm text-muted-foreground">
          No local keys are stored in this app yet.
        </p>
      )}
      {keys && keys.keys.length > 0 && !selectedKeyId && !listError && (
        <p role="status" className="text-sm text-muted-foreground">
          No key selected.
        </p>
      )}
      {keys?.issues.length ? (
        <p role="status" className="text-xs leading-relaxed text-warning">
          {keys.issues.length} stored{" "}
          {keys.issues.length === 1 ? "entry is" : "entries are"} preserved but
          unavailable ({issueReasons.join(" ")}). They are not treated as valid
          keys and were not modified.
        </p>
      ) : null}
      {keys?.truncated && (
        <p role="status" className="text-xs text-warning">
          The local key list was truncated. Only the first bounded entries are
          shown.
        </p>
      )}
      <div className="border-t border-border/70 pt-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={storageOpen}
          onClick={() => setStorageOpen((value) => !value)}
          className="-ml-2.5 text-muted-foreground"
        >
          Storage details
        </Button>
        {storageOpen && (
          <div className="mt-1 space-y-1 text-xs leading-relaxed text-muted-foreground">
            <p>
              Named keys are stored in{" "}
              <span className="break-all">
                {keys?.storagePath ?? "the standard SSH folder"}
              </span>
              . Older app-vault keys remain at{" "}
              <span className="break-all">
                {keys?.legacyStoragePath ?? "the app's private key folder"}
              </span>
              .
            </p>
            <p>
              Selected existing keys stay at their original paths. VPS Pilot has
              no key deletion or overwrite action.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { desktopAvailable, safeError } from "./api";
import { QuickSetupAccess } from "./quick-setup-access";

export type KeyLocation = "ssh" | "legacy";
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
}
interface CopyResult {
  status: "copied" | "already";
  key: SetupKey;
}

function passphraseBytes(value: string) {
  return new TextEncoder().encode(value).length;
}

export function QuickSetupKeyManager({
  selectedKeyId,
  onSelectKey,
  source,
  connectionId,
  connected,
  target,
}: {
  selectedKeyId?: string;
  onSelectKey: (keyId: string) => void;
  source: {
    profileId: string;
    profileRevision: string;
    host: string;
  };
  connectionId?: string | null;
  connected: boolean;
  target: { username: string; port: number };
}) {
  const id = useId();
  const [keys, setKeys] = useState<SetupKeyList | null>(null);
  const [listError, setListError] = useState("");
  const [loading, setLoading] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [mutation, setMutation] = useState<
    "load" | "create" | "copy" | "export" | null
  >(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [copying, setCopying] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [storedOpen, setStoredOpen] = useState(false);
  const [storageOpen, setStorageOpen] = useState(false);
  const [accessBusy, setAccessBusy] = useState(false);
  const active = useRef(true);
  const accessBusyRef = useRef(false);
  const mutationGate = useRef<"load" | "create" | "copy" | "export" | null>(
    null,
  );
  const createRequest = useRef(0);
  const copyRequest = useRef(0);
  const exportRequest = useRef(0);
  const loadRequest = useRef(0);

  const handleAccessBusy = useCallback((busy: boolean) => {
    accessBusyRef.current = busy;
    setAccessBusy(busy);
  }, []);

  const load = useCallback(async () => {
    if (!desktopAvailable) {
      setListError(
        "The local encrypted key vault is available only in the desktop app.",
      );
      return;
    }
    // One mutation at a time; a reload never queues behind generation/export
    // or an active key-login operation.
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
    } catch (failure) {
      if (!active.current || token !== loadRequest.current) return;
      setListError(
        `${safeError(failure)} Stored keys were not listed; existing entries are preserved.`,
      );
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
      copyRequest.current += 1;
      exportRequest.current += 1;
      loadRequest.current += 1;
      // Release only the load gate from this effect run. A user mutation's
      // worker owns its own gate; a stale reply can never release a newer one.
      if (mutationGate.current === "load") mutationGate.current = null;
    };
  }, [load]);

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
  const canCreate =
    desktopAvailable &&
    keys !== null &&
    listError.length === 0 &&
    mutation === null &&
    !accessBusy &&
    measured >= 12 &&
    measured <= 4096 &&
    confirmation === passphrase &&
    passphrase.length > 0;

  async function createKey() {
    if (!canCreate || mutationGate.current || accessBusyRef.current) return;
    // Copy the transient value for this IPC call, then clear the inputs before
    // awaiting so no passphrase lingers in component state.
    const secret = passphrase;
    setPassphrase("");
    setConfirmation("");
    const token = ++createRequest.current;
    mutationGate.current = "create";
    setMutation("create");
    setError("");
    setNotice("");
    let refresh = false;
    try {
      const key = await invoke<SetupKey>("app_setup_key_generate", {
        passphrase: secret,
      });
      if (!active.current || token !== createRequest.current) return;
      // Keep the opaque reference even though the key is not installed.
      onSelectKey(key.keyId);
      setCreateOpen(false);
      setNotice("Key created on this device.");
      refresh = true;
    } catch (failure) {
      if (!active.current || token !== createRequest.current) return;
      setError(
        `${safeError(failure)} The existing key selection was preserved. Reload local keys to check whether a key was published; nothing was retried.`,
      );
      // A native error can still mean the key was published before a sync
      // failure. Discover it; never auto-retry and never erase the reference.
      refresh = true;
    } finally {
      if (token === createRequest.current) {
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
        setNotice("Backup canceled. The encrypted key was not copied.");
      } else {
        setNotice(
          `Encrypted key copied to ${
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

  function selectKey(keyId: string) {
    if (mutationGate.current || accessBusyRef.current) return;
    onSelectKey(keyId);
    setStoredOpen(false);
  }

  const selectedKey =
    keys?.keys.find((key) => key.keyId === selectedKeyId) ?? null;
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
  const showCreateForm = !selectedKey || createOpen;

  const createForm = (
    <fieldset id={`${id}-create`} className="space-y-3 border-0 p-0">
      <legend className="text-sm font-medium">Create an encrypted key</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor={`${id}-passphrase`} className="block text-sm">
            Passphrase
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
            Confirm passphrase
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
          ? "Creating encrypted key…"
          : "Create encrypted key"}
      </Button>
      {!selectedKey && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          VPS Pilot cannot recover a forgotten passphrase. Back up the encrypted
          key.
        </p>
      )}
    </fieldset>
  );

  return (
    <div className="space-y-4 border-t border-border/70 pt-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">Local encrypted key</h3>
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
                {selectedKey.algorithm} · Encrypted ·{" "}
                {selectedKey.location === "ssh"
                  ? "Stored in ~/.ssh"
                  : "App vault"}{" "}
                · Local key
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
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
                disabled={mutation !== null || accessBusy}
                onClick={() => void backup(selectedKey.keyId)}
              >
                {exporting === selectedKey.keyId
                  ? "Saving backup…"
                  : "Backup encrypted key"}
              </Button>
            </div>
          </div>
          {selectedKey.location === "legacy" && (
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              This key is in the app vault. Put it in ~/.ssh before verifying
              key login; the app vault copy is kept.
            </p>
          )}
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            VPS Pilot cannot recover a forgotten passphrase. Back up the
            encrypted key.
          </p>
        </fieldset>
      )}

      {selectedKey?.location === "ssh" && (
        <QuickSetupAccess
          source={source}
          connectionId={connectionId}
          connected={connected}
          target={target}
          selectedKey={selectedKey}
          keyBusy={mutation !== null}
          onBusyChange={handleAccessBusy}
        />
      )}

      {selectedKey && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={createOpen}
          aria-controls={`${id}-create`}
          disabled={mutation !== null || accessBusy}
          onClick={() => setCreateOpen((value) => !value)}
          className="-ml-2.5 text-muted-foreground"
        >
          Create another key
        </Button>
      )}
      {showCreateForm && createForm}

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
              aria-label="Stored encrypted keys"
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
                      {key.algorithm} · Encrypted ·{" "}
                      {key.location === "ssh" ? "In ~/.ssh" : "App vault"}
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
                      onClick={() => selectKey(key.keyId)}
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
          No generated keys are stored in this app yet.
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
              Stored at{" "}
              <span className="break-all">
                {keys?.storagePath ?? "the app's private key folder"}
              </span>
              .
            </p>
            <p>
              Generated keys remain in this local vault after resetting the
              setup draft. VPS Pilot has no key deletion action.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

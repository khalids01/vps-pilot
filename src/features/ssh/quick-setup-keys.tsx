import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { desktopAvailable, safeError } from "./api";

interface SetupKey {
  keyId: string;
  fingerprint: string;
  algorithm: string;
  encrypted: boolean;
  path: string;
}
interface SetupKeyIssue {
  keyId: string | null;
  reason: string;
}
interface SetupKeyList {
  keys: SetupKey[];
  issues: SetupKeyIssue[];
  storagePath: string;
  truncated: boolean;
}
interface ExportResult {
  status: "exported" | "canceled";
  path: string | null;
}

function passphraseBytes(value: string) {
  return new TextEncoder().encode(value).length;
}

export function QuickSetupKeyManager({
  selectedKeyId,
  onSelectKey,
}: {
  selectedKeyId?: string;
  onSelectKey: (keyId: string) => void;
}) {
  const id = useId();
  const [keys, setKeys] = useState<SetupKeyList | null>(null);
  const [listError, setListError] = useState("");
  const [loading, setLoading] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [mutation, setMutation] = useState<"load" | "create" | "export" | null>(
    null,
  );
  const [exporting, setExporting] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const active = useRef(true);
  const mutationGate = useRef<"load" | "create" | "export" | null>(null);
  const createRequest = useRef(0);
  const exportRequest = useRef(0);
  const loadRequest = useRef(0);

  const load = useCallback(async () => {
    if (!desktopAvailable) {
      setListError(
        "The local encrypted key vault is available only in the desktop app.",
      );
      return;
    }
    // One mutation at a time; a reload never queues behind generation/export.
    if (mutationGate.current) return;
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
    measured >= 12 &&
    measured <= 4096 &&
    confirmation === passphrase &&
    passphrase.length > 0;

  async function createKey() {
    if (!canCreate || mutationGate.current) return;
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
      setNotice(
        `Encrypted key created (${key.fingerprint}). It is selected for this setup draft, but it is not installed on a server and key login is not verified.`,
      );
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

  async function backup(keyId: string) {
    if (!desktopAvailable || mutationGate.current) return;
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
    if (mutationGate.current) return;
    onSelectKey(keyId);
  }

  const selectedKey =
    keys?.keys.find((key) => key.keyId === selectedKeyId) ?? null;
  const selectedMissing =
    Boolean(selectedKeyId) && Boolean(keys) && selectedKey === null;
  const issueReasons = [...new Set(keys?.issues.map((issue) => issue.reason))];

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">Local encrypted keys</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Generated Ed25519 keys are encrypted with your passphrase and stored
            only on this device as OpenSSH private files. Location:{" "}
            <span className="break-all">
              {keys?.storagePath ?? "the app's private key folder"}
            </span>
            .
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={mutation !== null}
          onClick={() => void load()}
        >
          {loading ? "Loading keys…" : "Reload keys"}
        </Button>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Create an encrypted key</legend>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Use a passphrase of 12–4096 bytes. VPS Pilot does not save the
          passphrase and cannot recover a key if you lose it. Create a backup
          you can store safely.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label htmlFor={`${id}-passphrase`} className="block text-sm">
            Passphrase
            <Input
              id={`${id}-passphrase`}
              className="mt-2"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={passphrase}
              disabled={mutation !== null}
              aria-invalid={Boolean(passphraseError)}
              aria-describedby={
                passphraseError ? `${id}-passphrase-error` : `${id}-hint`
              }
              onChange={(event) => setPassphrase(event.target.value)}
            />
          </label>
          <label htmlFor={`${id}-confirmation`} className="block text-sm">
            Confirm passphrase
            <Input
              id={`${id}-confirmation`}
              className="mt-2"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={confirmation}
              disabled={mutation !== null}
              aria-invalid={Boolean(confirmationError)}
              aria-describedby={
                confirmationError ? `${id}-confirmation-error` : `${id}-hint`
              }
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </label>
        </div>
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          Passphrase and confirmation stay in memory only and are cleared after
          creation, failure or leaving this step.
        </p>
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
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            disabled={!canCreate}
            onClick={() => void createKey()}
          >
            {mutation === "create"
              ? "Creating encrypted key…"
              : "Create encrypted key"}
          </Button>
          <p className="text-xs text-muted-foreground">
            Creating a key is local only. It does not install a public key or
            test SSH login.
          </p>
        </div>
      </fieldset>

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

      {selectedKey && (
        <fieldset className="space-y-2 rounded-lg border bg-muted/30 p-3">
          <legend className="text-sm font-medium">Selected local key</legend>
          <p className="break-all text-sm">{selectedKey.fingerprint}</p>
          <p className="text-xs text-muted-foreground">
            {selectedKey.algorithm} · Encrypted · Not installed on a server
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={mutation !== null}
            onClick={() => void backup(selectedKey.keyId)}
          >
            {exporting === selectedKey.keyId
              ? "Saving backup…"
              : "Backup encrypted key"}
          </Button>
        </fieldset>
      )}
      {selectedMissing && (
        <p role="status" className="text-sm text-warning">
          The saved key reference is not available in this local vault. The
          reference was preserved; choose another key or reload the list.
        </p>
      )}

      {keys && keys.keys.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Stored keys</p>
          <ul aria-label="Stored encrypted keys" className="space-y-2">
            {keys.keys.map((key) => {
              const selected = key.keyId === selectedKeyId;
              return (
                <li
                  key={key.keyId}
                  className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                >
                  <div className="min-w-0">
                    <p className="break-all text-sm">{key.fingerprint}</p>
                    <p className="text-xs text-muted-foreground">
                      {key.algorithm} · Encrypted
                    </p>
                    <p className="break-all text-xs text-muted-foreground">
                      {key.path}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant={selected ? "secondary" : "outline"}
                    aria-pressed={selected}
                    aria-label={`Select key ${key.fingerprint}`}
                    disabled={mutation !== null}
                    onClick={() => selectKey(key.keyId)}
                  >
                    {selected ? "Selected" : "Use key"}
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {keys && keys.keys.length === 0 && !keys.issues.length && (
        <p role="status" className="text-sm text-muted-foreground">
          No generated keys are stored in this app yet.
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
      <p className="text-xs leading-relaxed text-muted-foreground">
        Generated keys remain in this local vault after resetting the setup
        draft. VPS Pilot has no key deletion action.
      </p>
    </div>
  );
}

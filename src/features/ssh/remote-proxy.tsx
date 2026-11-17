import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { type ServerProfile, safeError } from "./api";
import { useConfiguration } from "./configuration-context";
import { RemoteActions } from "./remote-actions";

interface ProxyStatus {
  manager: string;
  installed: boolean;
  status: string;
  config?: string;
  supported: boolean;
  message?: string;
}
const managers = [{ id: "caddy", label: "Caddy" }] as const;
export function RemoteProxy({
  profile,
  connected,
}: {
  profile: ServerProfile;
  connected: boolean;
}) {
  const { connectionId } = useConfiguration();
  const [status, setStatus] = useState<ProxyStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  useEffect(() => {
    void profile.id;
    void profile.revision;
    void connectionId;
    sequence.current++;
    setStatus(null);
    setBusy(false);
    setError("");
    return () => {
      sequence.current++;
    };
  }, [profile.id, profile.revision, connectionId]);
  async function detect() {
    const current = ++sequence.current;
    setBusy(true);
    setError("");
    try {
      const result = await invoke<ProxyStatus>("ssh_proxy_detect", {
        profileId: profile.id,
        profileRevision: profile.revision,
        connectionId,
        manager: managers[0].id,
      });
      if (current === sequence.current) setStatus(result);
    } catch (e) {
      if (current === sequence.current) setError(safeError(e));
    } finally {
      if (current === sequence.current) setBusy(false);
    }
  }
  return (
    <section aria-label="Proxy managers" className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Proxy</h1>
        <Button disabled={!connected || busy} onClick={detect}>
          {busy ? "Checking…" : "Detect"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {status && (
        <div className="space-y-2 rounded-lg border p-4">
          <div className="flex justify-between text-sm">
            <strong>Caddy</strong>
            <span>{status.installed ? status.status : "Not installed"}</span>
          </div>
          {status.config && (
            <p className="break-all text-xs text-muted-foreground">
              {status.config}
            </p>
          )}
          {status.message && (
            <p className="text-xs text-muted-foreground">{status.message}</p>
          )}
        </div>
      )}
      {status?.supported && (
        <RemoteActions
          profile={profile}
          connected={connected && !busy}
          tool="Proxy"
        />
      )}
    </section>
  );
}

import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { type ServerProfile, safeError } from "./api";
import { useConfiguration } from "./configuration-context";
import { ProxyConfigEditor } from "./proxy-config-editor";
import { ProxyTextEditor as TextEditor } from "./proxy-text-editor";
import type {
  ProxyInstance,
  ProxyIntent,
  ProxyResult,
} from "./proxy-workspace-types";

interface Plan {
  id: string;
  command: string;
  operation: string;
  path: string;
  instanceId: string;
}
export function RemoteProxy({
  profile,
  connected,
  active: isActive = true,
}: {
  profile: ServerProfile;
  connected: boolean;
  active?: boolean;
}) {
  const { connectionId } = useConfiguration();
  const [instances, setInstances] = useState<ProxyInstance[]>([]);
  const [detected, setDetected] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [workspace, setWorkspace] = useState<ProxyResult | null>(null);
  const [active, setActive] = useState<ProxyInstance | null>(null);
  const [intent, setIntent] = useState<ProxyIntent | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [password, setPassword] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [logs, setLogs] = useState<string | null>(null);
  const [backup, setBackup] = useState<{
    id: string;
    instance: ProxyInstance;
    path: string;
  } | null>(null);
  const generation = useRef(0);
  const pending = useRef<string | null>(null);
  const clearReview = useCallback(() => {
    const id = pending.current;
    pending.current = null;
    setPlan(null);
    setIntent(null);
    setPassword("");
    setAck(false);
    if (id)
      void invoke("ssh_proxy_workspace_reject", { reviewId: id }).catch(
        () => {},
      );
  }, []);
  useEffect(() => {
    void profile.id;
    void profile.revision;
    void connectionId;
    generation.current++;
    setInstances([]);
    setDetected(false);
    setWarnings([]);
    setWorkspace(null);
    setActive(null);
    setLogs(null);
    setBackup(null);
    setError("");
    setMessage("");
    setBusy(false);
    clearReview();
    return () => {
      generation.current++;
      if (pending.current)
        void invoke("ssh_proxy_workspace_reject", {
          reviewId: pending.current,
        }).catch(() => {});
    };
    // Clear all secret-bearing drafts when server identity changes.
  }, [profile.id, profile.revision, connectionId, clearReview]);
  useEffect(() => {
    function hidden() {
      if (document.hidden) {
        generation.current++;
        clearReview();
        setWorkspace(null);
        setLogs(null);
        setActive(null);
        setBusy(false);
      }
    }
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  });
  useEffect(() => {
    if (!isActive) {
      generation.current++;
      clearReview();
      setWorkspace(null);
      setActive(null);
      setLogs(null);
      setBusy(false);
    }
  }, [isActive, clearReview]);
  async function review(next: ProxyIntent, instance?: ProxyInstance) {
    if (!connected || !connectionId || busy) return;
    const current = ++generation.current;
    clearReview();
    setBusy(true);
    setError("");
    setMessage("");
    setAck(false);
    const request = {
      ...next,
      instanceId: instance?.id ?? next.instanceId ?? active?.id ?? "",
      identity: instance?.identity ?? next.identity ?? active?.identity ?? "",
      profileId: profile.id,
      profileRevision: profile.revision,
      connectionId,
    };
    try {
      const result = await invoke<Plan>("ssh_proxy_workspace_review", {
        request,
      });
      if (current !== generation.current) {
        void invoke("ssh_proxy_workspace_reject", { reviewId: result.id });
        return;
      }
      pending.current = result.id;
      setIntent(request);
      setPlan(result);
    } catch (failure) {
      if (current === generation.current) setError(safeError(failure));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  async function execute() {
    if (!plan || !intent || busy) return;
    const current = ++generation.current;
    const approved = plan;
    const operation = intent.operation;
    const secret = password;
    setPassword("");
    pending.current = null;
    setPlan(null);
    setIntent(null);
    setBusy(true);
    setError("");
    try {
      const result = await invoke<ProxyResult>("ssh_proxy_workspace_execute", {
        reviewId: approved.id,
        password: secret,
        acknowledgeTraefik: ack,
      });
      if (current !== generation.current) return;
      if (result.instances) {
        setInstances(result.instances);
        setDetected(true);
        setWarnings(result.warnings ?? []);
        setWorkspace(null);
        setActive(null);
        setBackup(null);
        setLogs(null);
      }
      if (result.files && result.instance) {
        setWorkspace(result);
        setActive(result.instance);
        setInstances((old) =>
          old.map((item) =>
            item.id === result.instance?.id ? result.instance : item,
          ),
        );
      }
      if (result.logs !== undefined) setLogs(result.logs);
      if (result.backupId && result.instance)
        setBackup({
          id: result.backupId,
          instance: result.instance,
          path: approved.path,
        });
      if (operation === "restore") {
        setWorkspace(null);
        setBackup(null);
      }
      if (result.message) setMessage(result.message);
      if (operation === "restart") {
        setWorkspace(null);
        setInstances([]);
        setActive(null);
        setMessage(
          (result.message ?? "") +
            " Detect again to refresh the instance identity.",
        );
      }
    } catch (failure) {
      if (current === generation.current) setError(safeError(failure));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  const selected =
    instances.find((item) => item.id === intent?.instanceId) ?? active;
  const original =
    workspace?.files?.find((file) => file.path === intent?.path)?.content ?? "";
  return (
    <section aria-label="Proxy managers" className="min-w-0 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Proxy</h1>
        <Button
          disabled={!connected || busy}
          onClick={() => review({ operation: "inventory" })}
        >
          {busy ? "Working…" : "Detect"}
        </Button>
      </div>
      {error && (
        <p
          role="alert"
          className="whitespace-pre-wrap break-all text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      {warnings.map((warning) => (
        <p key={warning} className="text-xs text-muted-foreground">
          {warning}
        </p>
      ))}
      {instances.length === 0 && !busy && (
        <p className="text-sm text-muted-foreground">
          {detected
            ? "No proxy instances detected."
            : "Detect Caddy, Nginx and Traefik services and Docker containers."}
        </p>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        {instances.map((instance) => (
          <article
            key={instance.id}
            aria-label={`${instance.manager} ${instance.name}`}
            className="min-w-0 space-y-3 rounded-xl border bg-card p-4"
          >
            <div className="flex flex-wrap justify-between gap-2">
              <h2 className="font-semibold">
                {instance.manager === "nginx"
                  ? "Nginx"
                  : instance.manager === "traefik"
                    ? "Traefik"
                    : "Caddy"}{" "}
                <span className="text-xs font-normal text-muted-foreground">
                  {instance.kind === "docker" ? "Docker" : "System"}
                </span>
              </h2>
              <span className="text-xs">{instance.status}</span>
            </div>
            <p className="break-all text-sm">{instance.name}</p>
            {instance.roots.map((root) => (
              <p
                key={`${root.host}-${root.container}`}
                className="break-all font-mono text-xs text-muted-foreground"
              >
                {root.host}
                {instance.kind === "docker" ? ` → ${root.container}` : ""}
              </p>
            ))}
            {instance.composeProject && (
              <p className="text-xs text-muted-foreground">
                Compose · {instance.composeProject} / {instance.composeService}
              </p>
            )}
            {instance.labelRoutes && (
              <p className="text-xs text-muted-foreground">
                Docker-label routes belong to their application’s Compose
                configuration; this editor manages mounted file configuration.
              </p>
            )}
            {instance.message && (
              <p className="text-xs text-muted-foreground">
                {instance.message}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !connected || !instance.roots.length}
                onClick={() => review({ operation: "open" }, instance)}
              >
                Configs
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !connected || !instance.actions}
                onClick={() => review({ operation: "validate" }, instance)}
              >
                Validate
              </Button>
              {instance.manager !== "traefik" && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !connected || !instance.actions}
                  onClick={() => review({ operation: "reload" }, instance)}
                >
                  Reload
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !connected || !instance.actions}
                onClick={() => review({ operation: "restart" }, instance)}
              >
                Restart
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || !connected}
                onClick={() => review({ operation: "logs" }, instance)}
              >
                Logs
              </Button>
            </div>
          </article>
        ))}
      </div>
      {workspace?.files && workspace.instance && workspace.treeRevision && (
        <ProxyConfigEditor
          key={workspace.instance.id}
          instance={workspace.instance}
          files={workspace.files}
          treeRevision={workspace.treeRevision}
          busy={busy || !connected}
          onIntent={(next) => review(next, workspace.instance)}
          onClose={() => setWorkspace(null)}
        />
      )}
      {backup && (
        <Button
          variant="outline"
          disabled={busy || !connected}
          onClick={() =>
            review(
              { operation: "restore", backupId: backup.id, path: backup.path },
              backup.instance,
            )
          }
        >
          Restore last backup
        </Button>
      )}
      {logs !== null && (
        <section aria-label="Proxy logs" className="rounded-xl border">
          <div className="flex items-center justify-between p-3">
            <h2 className="text-sm font-medium">Logs</h2>
            <Button size="sm" variant="ghost" onClick={() => setLogs(null)}>
              Close logs
            </Button>
          </div>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all border-t p-3 text-xs">
            {logs || "No recent logs."}
          </pre>
        </section>
      )}
      <Dialog
        open={!!plan}
        onOpenChange={(open) => {
          if (!open) clearReview();
        }}
      >
        <DialogContent
          className={
            intent?.operation === "save"
              ? "max-h-[90dvh] overflow-auto sm:max-w-5xl"
              : "max-h-[85dvh] overflow-auto sm:max-w-xl"
          }
        >
          <DialogHeader>
            <DialogTitle>
              {intent?.operation === "save"
                ? "Review configuration changes"
                : `Approve proxy ${intent?.operation ?? "operation"}`}
            </DialogTitle>
            <DialogDescription>
              {profile.name}
              {selected ? ` · ${selected.name}` : ""}
              {intent?.path ? ` · ${intent.path}` : ""}
            </DialogDescription>
          </DialogHeader>
          {intent?.operation === "save" && (
            <div className="h-80">
              <TextEditor
                key={plan?.id}
                path={intent.path ?? ""}
                label="Proxy configuration diff"
                original={original}
                value={intent.content ?? ""}
                readOnly
              />
            </div>
          )}
          {(intent?.operation === "restart" ||
            intent?.operation === "save") && (
            <p className="text-xs text-muted-foreground">
              {selected?.manager === "traefik"
                ? "Traefik has no offline configuration test. Applying restarts this proxy and can interrupt traffic. Dynamic file watchers may apply a saved file immediately. Process verification does not verify every route."
                : intent.operation === "save"
                  ? "Validate the candidate, back up the original file, save and reload. Failed application restores the file; runtime recovery may need a separate restart."
                  : "Restart can briefly interrupt traffic."}
            </p>
          )}
          {intent?.operation === "save" && selected?.manager === "traefik" && (
            <label
              htmlFor="proxy-traefik-ack"
              className="flex items-center gap-2 text-sm"
            >
              <Checkbox
                id="proxy-traefik-ack"
                checked={ack}
                onCheckedChange={(value) => setAck(!!value)}
              />
              I understand the Traefik validation and restart limits
            </label>
          )}
          <details>
            <summary className="cursor-pointer text-xs">
              Administrator command
            </summary>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all text-xs">
              {plan?.command}
            </pre>
          </details>
          <Input
            aria-label="Proxy sudo password"
            type="password"
            autoComplete="off"
            value={password}
            placeholder="Sudo password, if required"
            onChange={(event) => setPassword(event.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={clearReview}>
              Cancel
            </Button>
            <Button
              disabled={
                busy ||
                (intent?.operation === "save" &&
                  selected?.manager === "traefik" &&
                  !ack)
              }
              onClick={() => void execute()}
            >
              {intent?.operation === "save"
                ? "Save & apply"
                : intent?.operation === "restore"
                  ? "Restore file"
                  : "Approve"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

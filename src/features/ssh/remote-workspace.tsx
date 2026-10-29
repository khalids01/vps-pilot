import { useQueryClient } from "@tanstack/react-query";
import {
  Container,
  HardDrive,
  LayoutDashboard,
  Network,
  Package,
  Plug,
  Shield,
  Terminal,
  Unplug,
  Workflow,
} from "lucide-react";
import { lazy, Suspense, useRef, useState } from "react";
import type { ToolId } from "@/features/workspace/fixtures";
import { RemoteActions } from "./remote-actions";
import { RemoteInspection } from "./remote-inspection";

const RemoteTerminal = lazy(() =>
  import("./remote-terminal").then((module) => ({
    default: module.RemoteTerminal,
  })),
);

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
import {
  address,
  type ConnectionStatus,
  type Inspection,
  type ServerProfile,
  safeError,
  sshApi,
  statusQueryKey,
} from "./api";

export function RemoteWorkspace({
  profile,
  status,
  selectedTool,
  active,
  onSelectTool,
}: {
  profile: ServerProfile;
  status?: ConnectionStatus;
  selectedTool: ToolId;
  active: boolean;
  onSelectTool: (tool: ToolId) => void;
}) {
  const queryClient = useQueryClient();
  const labels: Record<ToolId, string> = {
    overview: "Overview",
    terminal: "Terminal",
    software: "Software",
    docker: "Docker",
    proxy: "Proxy",
    services: "Services",
    storage: "Storage",
    firewall: "Firewall",
    helper: "Server helper",
    network: "Network",
    processes: "Processes",
  };
  const [tool, setTool] = useState(labels[selectedTool]);
  const [terminalOpened, setTerminalOpened] = useState(
    selectedTool === "terminal",
  );
  const [phase, setPhase] = useState<
    "inspect" | "identity" | "password" | null
  >(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [verified, setVerified] = useState(false);
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [challengeConsumed, setChallengeConsumed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const connected = status?.status === "connected";
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: statusQueryKey });
  async function cancel() {
    request.current++;
    setPassword("");
    setPassphrase("");
    setPhase(null);
    setBusy(false);
    setInspection(null);
    setVerified(false);
    try {
      await sshApi.disconnect(profile.id);
      await refresh();
    } catch (error) {
      setError(safeError(error));
    }
  }
  async function inspect() {
    setChallengeConsumed(false);
    const current = ++request.current;
    setError("");
    setVerified(false);
    setInspection(null);
    setPassword("");
    setPassphrase("");
    setBusy(true);
    setPhase("inspect");
    try {
      const result = await sshApi.inspect(profile.id);
      if (request.current !== current) return;
      setInspection(result);
      setPhase(result.status === "known" ? "password" : "identity");
    } catch (error) {
      if (request.current === current) {
        setError(safeError(error));
        setPhase(null);
      }
    } finally {
      if (request.current === current) setBusy(false);
      await refresh();
    }
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav
          aria-label={`${profile.name} tools`}
          className="flex shrink-0 gap-1 overflow-x-auto border-b bg-sidebar p-2 md:w-48 md:flex-col md:border-r md:border-b-0 md:p-3"
        >
          {[
            { label: "Overview", icon: LayoutDashboard },
            { label: "Terminal", icon: Terminal },
            { label: "Software", icon: Package },
            { label: "Docker", icon: Container },
            { label: "Proxy", icon: Network },
            { label: "Services", icon: Workflow },
            { label: "Storage", icon: HardDrive },
            { label: "Firewall", icon: Shield },
            { label: "Network", icon: Network },
            { label: "Processes", icon: Workflow },
            { label: "Server helper", icon: Plug },
          ].map(({ label, icon: Icon }) => (
            <Button
              key={label}
              variant="ghost"
              onClick={() => {
                setTool(label);
                const id = (Object.keys(labels) as ToolId[]).find(
                  (key) => labels[key] === label,
                );
                if (id) onSelectTool(id);
                if (label === "Terminal") setTerminalOpened(true);
              }}
              aria-current={label === tool ? "page" : undefined}
              className={`h-10 justify-start gap-3 px-3 ${label === tool ? "bg-sidebar-accent text-primary" : "text-muted-foreground"}`}
            >
              <Icon className="size-4" aria-hidden="true" />
              {label}
            </Button>
          ))}
        </nav>
        <main
          aria-label={`${profile.name}: Connection`}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto p-5 sm:p-8"
        >
          <div className="mx-auto w-full max-w-6xl">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h1 className="text-xl font-medium tracking-tight">
                  {profile.name}
                </h1>
                <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
                  {address(profile)}
                </p>
              </div>
              {connected ? (
                <Button
                  variant="outline"
                  onClick={async () => {
                    setError("");
                    try {
                      await sshApi.disconnect(profile.id);
                      await refresh();
                    } catch (error) {
                      setError(safeError(error));
                    }
                  }}
                >
                  <Unplug aria-hidden="true" />
                  Disconnect
                </Button>
              ) : (
                <Button
                  disabled={!status || busy || status.status === "connecting"}
                  onClick={inspect}
                >
                  {busy || status?.status === "connecting"
                    ? "Connecting…"
                    : "Connect"}
                </Button>
              )}
            </div>
            <div className="mt-8 flex items-center gap-2 border-b pb-4 text-sm">
              <span
                className={`size-2 rounded-full ${connected ? "bg-primary" : "bg-muted-foreground/50"}`}
              />
              <span>
                {connected
                  ? "Connected"
                  : status?.status === "failed"
                    ? "Connection failed"
                    : status?.status === "connecting"
                      ? "Connecting…"
                      : status
                        ? "Disconnected"
                        : "Checking connection…"}
              </span>
            </div>
            {(error || status?.error) && (
              <p role="alert" className="mt-4 text-sm text-destructive">
                {error || status?.error}
              </p>
            )}
            {tool === "Overview" && (
              <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-4 gap-y-5 py-6 text-sm">
                <dt className="text-muted-foreground">Host</dt>
                <dd className="break-all font-mono text-xs">{profile.host}</dd>
                <dt className="text-muted-foreground">User</dt>
                <dd className="font-mono text-xs">{profile.username}</dd>
                <dt className="text-muted-foreground">Port</dt>
                <dd className="font-mono text-xs">{profile.port}</dd>
                <dt className="text-muted-foreground">Key</dt>
                <dd className="break-all font-mono text-xs">
                  {profile.identityFile || "SSH agent / default keys"}
                </dd>
              </dl>
            )}
            <p className="border-t pt-5 text-xs text-muted-foreground">
              {connected
                ? "SSH is connected. Open Terminal for an interactive shell, or inspect a tool below."
                : "Connect when you’re ready. Your saved tabs won’t reconnect on their own."}
            </p>
            <div className="mt-6">
              {terminalOpened && (
                <div
                  className={tool === "Terminal" ? "flex flex-col" : "hidden"}
                >
                  <Suspense fallback={<p>Loading terminal workspace…</p>}>
                    <RemoteTerminal profile={profile} connected={connected} />
                  </Suspense>
                </div>
              )}
              <div
                className={
                  tool === "Terminal" || tool === "Server helper"
                    ? "hidden"
                    : "block"
                }
              >
                <RemoteInspection
                  profile={profile}
                  connected={connected}
                  tool={tool}
                  active={active}
                />
                <div className="mt-5">
                  <RemoteActions
                    profile={profile}
                    connected={connected}
                    tool={tool}
                  />
                </div>
              </div>
              {tool === "Server helper" && (
                <section className="rounded-lg border p-6">
                  <h2 className="font-medium">SSH-first management</h2>
                  <p className="mt-3 text-sm text-muted-foreground">
                    Current features run directly over SSH and do not require a
                    helper. No helper has been installed. Helper installation is
                    unavailable.
                  </p>
                </section>
              )}
            </div>
          </div>
        </main>
      </div>
      <footer className="flex shrink-0 flex-wrap justify-between gap-2 border-t bg-sidebar px-4 py-2 text-[11px] text-muted-foreground">
        <span className="break-all">
          {profile.name} · {address(profile)}
        </span>
        <span>
          {connected
            ? "SSH authenticated · app actions read-only"
            : status
              ? "No active SSH connection"
              : "Waiting for desktop connection status"}
        </span>
      </footer>
      <Dialog
        open={phase !== null}
        onOpenChange={(open) => {
          if (!open) void cancel();
        }}
      >
        {phase && (
          <DialogContent
            className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
            showCloseButton={false}
          >
            <DialogHeader>
              <DialogTitle>
                {phase === "inspect"
                  ? "Checking host key…"
                  : phase === "password"
                    ? `Connect to ${profile.name}`
                    : inspection?.status === "changed"
                      ? "Host identity changed — blocked"
                      : "Trust this server?"}
              </DialogTitle>
              <DialogDescription>
                {profile.name} · {address(profile)}
              </DialogDescription>
            </DialogHeader>
            {phase === "inspect" ? (
              <p role="status" className="text-sm text-muted-foreground">
                Waiting for the server’s host key.
              </p>
            ) : (
              <>
                {phase === "identity" && (
                  <dl className="space-y-3 border-y py-4">
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        Algorithm
                      </dt>
                      <dd className="mt-1 text-sm">
                        {inspection?.observed.algorithm}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        SHA256 fingerprint
                      </dt>
                      <dd className="mt-1 select-all break-all font-mono text-xs">
                        {inspection?.observed.fingerprint}
                      </dd>
                    </div>
                    {inspection?.previous &&
                      inspection.status === "changed" && (
                        <div>
                          <dt className="text-xs text-destructive">
                            Previously trusted fingerprint
                          </dt>
                          <dd className="mt-1 break-all font-mono text-xs">
                            {inspection.previous.fingerprint}
                          </dd>
                        </div>
                      )}
                  </dl>
                )}
                {phase === "identity" ? (
                  inspection?.status === "changed" ? (
                    <p
                      role="alert"
                      className="text-sm leading-relaxed text-destructive"
                    >
                      This host key differs from the one you saved.
                      Authentication is blocked. Check the change with your
                      server provider.
                    </p>
                  ) : (
                    <>
                      <p className="text-sm leading-relaxed text-muted-foreground">
                        Compare this fingerprint with your server console or
                        another trusted source before saving it.
                      </p>
                      <div className="flex items-start gap-3">
                        <Checkbox
                          id={`trust-${profile.id}`}
                          checked={verified}
                          onCheckedChange={setVerified}
                          className="mt-0.5"
                        />
                        <label
                          htmlFor={`trust-${profile.id}`}
                          className="text-sm"
                        >
                          I verified this fingerprint.
                        </label>
                      </div>
                    </>
                  )
                ) : (
                  <form
                    id={`authenticate-${profile.id}`}
                    onSubmit={async (event) => {
                      event.preventDefault();
                      const current = ++request.current;
                      const credential = password;
                      const keyPassphrase = passphrase;
                      setPassword("");
                      setPassphrase("");
                      setChallengeConsumed(true);
                      setBusy(true);
                      setError("");
                      try {
                        await sshApi.connect(
                          profile.id,
                          inspection?.challengeId ?? "",
                          credential,
                          keyPassphrase,
                        );
                        if (request.current === current) {
                          setPhase(null);
                          setInspection(null);
                        }
                      } catch (error) {
                        if (request.current === current)
                          setError(safeError(error));
                      } finally {
                        if (request.current === current) setBusy(false);
                        await refresh();
                      }
                    }}
                  >
                    {profile.passwordAllowed !== false && (
                      <label
                        htmlFor={`password-${profile.id}`}
                        className="block text-sm"
                      >
                        Password{" "}
                        <span className="text-muted-foreground">
                          (optional)
                        </span>
                        <Input
                          id={`password-${profile.id}`}
                          className="mt-2"
                          type="password"
                          autoComplete="off"
                          value={password}
                          maxLength={4096}
                          disabled={busy || challengeConsumed}
                          onChange={(event) => setPassword(event.target.value)}
                        />
                      </label>
                    )}
                    <p className="mt-2 text-xs text-muted-foreground">
                      {profile.identityFile
                        ? "Leave blank to use your private key."
                        : "Leave blank to use your SSH agent or default key."}
                    </p>
                    <details
                      className="mt-5 text-sm"
                      open={profile.identityFile ? true : undefined}
                    >
                      <summary className="cursor-pointer text-muted-foreground">
                        Key passphrase
                      </summary>
                      <label
                        className="mt-3 block text-xs text-muted-foreground"
                        htmlFor={`passphrase-${profile.id}`}
                      >
                        Only needed for an encrypted key
                        <Input
                          id={`passphrase-${profile.id}`}
                          className="mt-2"
                          type="password"
                          autoComplete="off"
                          value={passphrase}
                          maxLength={4096}
                          disabled={busy || challengeConsumed}
                          onChange={(event) =>
                            setPassphrase(event.target.value)
                          }
                        />
                      </label>
                    </details>
                    <p className="mt-4 text-xs text-muted-foreground">
                      Credentials are never saved.
                    </p>
                  </form>
                )}
              </>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => void cancel()}>
                Cancel
              </Button>
              {phase === "identity" && inspection?.status === "unknown" && (
                <Button
                  disabled={!verified || busy}
                  onClick={async () => {
                    if (!inspection) return;
                    setBusy(true);
                    setError("");
                    const current = request.current;
                    try {
                      await sshApi.trust(profile.id, inspection.challengeId);
                      if (request.current === current) setPhase("password");
                    } catch (error) {
                      if (request.current === current)
                        setError(safeError(error));
                    } finally {
                      if (request.current === current) setBusy(false);
                    }
                  }}
                >
                  Trust and continue
                </Button>
              )}
              {phase === "password" && challengeConsumed && !busy ? (
                <Button onClick={inspect}>Verify and retry</Button>
              ) : (
                phase === "password" && (
                  <Button
                    type="submit"
                    form={`authenticate-${profile.id}`}
                    disabled={busy}
                  >
                    {busy ? "Authenticating…" : "Connect"}
                  </Button>
                )
              )}
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

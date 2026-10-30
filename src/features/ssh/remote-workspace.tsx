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
import { CommandActivityProvider } from "./command-activity";
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

interface RemoteWorkspaceProps {
  profile: ServerProfile;
  status?: ConnectionStatus;
  selectedTool: ToolId;
  active: boolean;
  onSelectTool: (tool: ToolId) => void;
}
export function RemoteWorkspace(props: RemoteWorkspaceProps) {
  return (
    <CommandActivityProvider
      key={props.profile.revision}
      serverId={props.profile.id}
      serverName={props.profile.name}
    >
      <RemoteWorkspaceContent {...props} />
    </CommandActivityProvider>
  );
}
function RemoteWorkspaceContent({
  profile,
  status,
  selectedTool,
  active,
  onSelectTool,
}: RemoteWorkspaceProps) {
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
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState("");
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
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b bg-sidebar/40 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="text-sm font-medium">{profile.name}</h1>
          <span
            className="max-w-60 truncate font-mono text-[11px] text-muted-foreground"
            title={address(profile)}
          >
            {address(profile)}
          </span>
          <span className="flex items-center gap-1.5 text-[11px]">
            <span
              className={`size-1.5 rounded-full ${connected ? "bg-primary" : "bg-muted-foreground"}`}
            />
            {connected
              ? "Connected"
              : busy || status?.status === "connecting"
                ? "Connecting…"
                : status
                  ? "Disconnected"
                  : "Checking…"}
          </span>
          <span className="rounded-md border bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground">
            Read-only actions
          </span>
        </div>
        <div className="flex items-center gap-2">
          <details className="group relative">
            <summary className="cursor-pointer list-none rounded-md px-2 py-1 text-xs text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
              Connection details
            </summary>
            <dl className="absolute top-full right-0 z-20 mt-2 grid w-72 grid-cols-[4rem_minmax(0,1fr)] gap-x-3 gap-y-3 rounded-xl border bg-popover p-4 text-xs shadow-lg">
              <dt className="text-muted-foreground">Host</dt>
              <dd className="break-all">{profile.host}</dd>
              <dt className="text-muted-foreground">User</dt>
              <dd>{profile.username}</dd>
              <dt className="text-muted-foreground">Port</dt>
              <dd>{profile.port}</dd>
              <dt className="text-muted-foreground">Key</dt>
              <dd className="break-all">
                {profile.identityFile || "SSH agent / default keys"}
              </dd>
            </dl>
          </details>
          {connected ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setDisconnectError("");
                setDisconnectOpen(true);
              }}
            >
              <Unplug />
              Disconnect
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={!status || busy || status.status === "connecting"}
              onClick={inspect}
            >
              {busy || status?.status === "connecting"
                ? "Connecting…"
                : "Connect"}
            </Button>
          )}
        </div>
      </header>
      {(error || status?.error) && (
        <p role="alert" className="border-b px-6 py-2 text-xs text-destructive">
          {error || status?.error}
        </p>
      )}
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
            <div>
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
      <Dialog
        open={disconnectOpen}
        onOpenChange={(open) => {
          if (!disconnecting) setDisconnectOpen(open);
        }}
      >
        <DialogContent showCloseButton={!disconnecting}>
          <DialogHeader>
            <DialogTitle>Disconnect from {profile.name}?</DialogTitle>
            <DialogDescription>
              {address(profile)} · This closes the SSH connection and all its
              terminal sessions, and interrupts app actions in progress. Remote
              processes may continue running. Reconnecting requires new terminal
              sessions.
            </DialogDescription>
          </DialogHeader>
          {disconnectError && (
            <p role="alert" className="text-sm text-destructive">
              {disconnectError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={disconnecting}
              onClick={() => setDisconnectOpen(false)}
            >
              Stay connected
            </Button>
            <Button
              disabled={disconnecting}
              onClick={async () => {
                setDisconnecting(true);
                setDisconnectError("");
                try {
                  await sshApi.disconnect(profile.id);
                  setDisconnectOpen(false);
                  await refresh();
                } catch (error) {
                  setDisconnectError(safeError(error));
                } finally {
                  setDisconnecting(false);
                }
              }}
            >
              {disconnecting ? "Disconnecting…" : "Disconnect"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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

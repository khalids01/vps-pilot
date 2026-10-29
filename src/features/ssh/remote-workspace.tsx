import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Container,
  HardDrive,
  LayoutDashboard,
  Network,
  Package,
  Plug,
  Shield,
  SquareTerminal,
  Terminal,
  Unplug,
  Workflow,
} from "lucide-react";
import { useRef, useState } from "react";
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
}: {
  profile: ServerProfile;
  status?: ConnectionStatus;
}) {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<
    "inspect" | "identity" | "password" | null
  >(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [verified, setVerified] = useState(false);
  const [password, setPassword] = useState("");
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
            { label: "Server helper", icon: Plug },
          ].map(({ label, icon: Icon }) => (
            <Button
              key={label}
              variant="ghost"
              disabled={label !== "Overview"}
              aria-current={label === "Overview" ? "page" : undefined}
              className={`h-10 justify-start gap-3 px-3 ${label === "Overview" ? "bg-sidebar-accent text-primary" : "text-muted-foreground"}`}
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
          <div className="mx-auto max-w-4xl">
            <p className="mb-2 text-[11px] uppercase tracking-widest text-primary">
              {profile.name} / Connection
            </p>
            <h1 className="text-2xl font-medium tracking-tight">
              {profile.name}
            </h1>
            <p className="mt-2 break-all text-sm text-muted-foreground">
              {address(profile)}
            </p>
            <section className="mt-7 rounded-xl border bg-card p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-base font-medium">SSH connection</h2>
                <span className="rounded-md bg-secondary px-2 py-1 text-xs">
                  {status?.status ?? "Status unavailable"}
                </span>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                {connected
                  ? "Authenticated SSH connection established. Switching tabs preserves this connection. Interactive terminal sessions and server discovery are the next increments."
                  : "Connect explicitly when you are ready. Restoring a workspace never reconnects automatically. Host identity is checked before your password is sent."}
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
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
                    <Plug aria-hidden="true" />
                    Verify and connect
                  </Button>
                )}
              </div>
              {(error || status?.error) && (
                <p role="alert" className="mt-4 text-sm text-destructive">
                  {error || status?.error}
                </p>
              )}
            </section>
            <section className="mt-5 rounded-xl border border-dashed p-5">
              <h2 className="text-sm font-medium">Connection foundation</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                This real server never uses sample metrics, software inventory,
                or terminal output. Management tools remain unavailable until
                their backends are implemented.
              </p>
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                Supported now: direct password authentication and app-owned
                SHA256 host-key pins. Key/agent authentication, SSH config
                import, jump hosts, host certificates, and interactive terminals
                follow separately.
              </p>
            </section>
          </div>
        </main>
      </div>
      <section
        aria-label={`${profile.name} command activity`}
        className="shrink-0 border-t bg-background/80 px-5 py-3"
      >
        <p className="flex items-center gap-2 text-xs font-medium">
          <SquareTerminal className="size-4 text-primary" aria-hidden="true" />
          Command activity · {profile.name}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          No remote commands have been run. Authentication does not start a
          shell.
        </p>
      </section>
      <footer className="flex shrink-0 flex-wrap justify-between gap-2 border-t bg-sidebar px-4 py-2 text-[11px] text-muted-foreground">
        <span className="break-all">
          {profile.name} · {address(profile)}
        </span>
        <span>
          {connected
            ? "SSH authenticated"
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
                  ? "Reading server identity"
                  : phase === "password"
                    ? "Authenticate over SSH"
                    : inspection?.status === "changed"
                      ? "Host identity changed — blocked"
                      : "Verify this server's identity"}
              </DialogTitle>
              <DialogDescription>
                {profile.name} · {address(profile)}
              </DialogDescription>
            </DialogHeader>
            {phase === "inspect" ? (
              <p role="status" className="text-sm text-muted-foreground">
                Opening a temporary SSH handshake. No password or remote command
                is sent.
              </p>
            ) : (
              <>
                <dl className="space-y-3 rounded-lg border bg-muted/30 p-4">
                  <div>
                    <dt className="text-xs text-muted-foreground">Algorithm</dt>
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
                  {inspection?.previous && inspection.status === "changed" && (
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
                {phase === "identity" ? (
                  inspection?.status === "changed" ? (
                    <p
                      role="alert"
                      className="text-sm leading-relaxed text-destructive"
                    >
                      The saved key no longer matches. No password will be sent.
                      Verify the change independently with your server provider.
                      Replacing an existing trusted identity is unavailable in
                      this increment.
                    </p>
                  ) : (
                    <>
                      <p className="text-sm leading-relaxed text-muted-foreground">
                        Compare this fingerprint with your server console or
                        another trusted source before accepting it. Acceptance
                        saves this host identity in VPS Pilot's own trust store.
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
                          I independently verified this fingerprint for{" "}
                          {profile.host}:{profile.port}.
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
                      setPassword("");
                      setChallengeConsumed(true);
                      setBusy(true);
                      setError("");
                      try {
                        await sshApi.connect(
                          profile.id,
                          inspection?.challengeId ?? "",
                          credential,
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
                    <label
                      htmlFor={`password-${profile.id}`}
                      className="text-sm"
                    >
                      SSH password for {profile.username}
                      <Input
                        id={`password-${profile.id}`}
                        className="mt-2"
                        type="password"
                        autoComplete="off"
                        value={password}
                        maxLength={4096}
                        disabled={busy || challengeConsumed}
                        required
                        onChange={(event) => setPassword(event.target.value)}
                      />
                    </label>
                    <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                      The password is used only for this connection and is not
                      saved in profiles, logs, history, or workspace
                      preferences. The host key is checked again before
                      authentication.
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
                  <Check aria-hidden="true" />
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
                    disabled={busy || !password}
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

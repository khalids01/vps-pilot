import { Channel, invoke } from "@tauri-apps/api/core";
import { ShieldCheck, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type ServerProfile, safeError } from "./api";
import {
  type CatalogId,
  catalogItems,
  softwareSafety,
} from "./software-safety";
import { type StreamEvent, streamApi } from "./streams";

type AppAction =
  | { type: "ufwStatus" }
  | {
      type: "serviceChange";
      unit: string;
      operation: "start" | "stop" | "restart" | "enable" | "disable";
    }
  | { type: "serviceLogs"; unit: string }
  | { type: "dockerLogs"; container: string }
  | { type: "diskScan"; path: string }
  | { type: "softwarePreflight"; software: CatalogId };
type Plan = {
  id: string;
  profileId: string;
  serverName: string;
  address: string;
  command: string;
  purpose: string;
  privileged: boolean;
  expiresInSeconds: number;
  evidence: string | null;
};
export function RemoteActions({
  profile,
  connected,
  tool,
}: {
  profile: ServerProfile;
  connected: boolean;
  tool: string;
}) {
  const [target, setTarget] = useState("");
  const [serviceOperation, setServiceOperation] = useState<
    "logs" | "start" | "stop" | "restart" | "enable" | "disable"
  >("logs");
  const [software, setSoftware] = useState<CatalogId>("nginx");
  const [report, setReport] = useState<ReturnType<
    typeof softwareSafety
  > | null>(null);
  const reviewSoftware = useRef<CatalogId | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState("");
  const [activity, setActivity] = useState<{
    command: string;
    state: string;
    text: string;
  } | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const pendingPlan = useRef<Plan | null>(null);
  const stream = useRef<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      if (pendingPlan.current)
        void invoke("ssh_action_reject", {
          profileId: profile.id,
          planId: pendingPlan.current.id,
        }).catch(() => {});
      if (stream.current)
        void streamApi.close(profile.id, stream.current).catch(() => {});
    };
  }, [profile.id]);
  async function dismiss() {
    generation.current++;
    const pending = pendingPlan.current;
    pendingPlan.current = null;
    setPlan(null);
    setPassword("");
    setReviewing(false);
    if (pending)
      await invoke("ssh_action_reject", {
        profileId: profile.id,
        planId: pending.id,
      }).catch(() => {});
  }
  async function review() {
    const action: AppAction | null =
      tool === "Software"
        ? { type: "softwarePreflight", software }
        : tool === "Firewall"
          ? { type: "ufwStatus" }
          : tool === "Services"
            ? serviceOperation === "logs"
              ? { type: "serviceLogs", unit: target.trim() }
              : {
                  type: "serviceChange",
                  unit: target.trim(),
                  operation: serviceOperation,
                }
            : tool === "Docker"
              ? { type: "dockerLogs", container: target.trim() }
              : tool === "Storage"
                ? { type: "diskScan", path: target }
                : null;
    if (!action) return;
    reviewSoftware.current = tool === "Software" ? software : null;
    setReport(null);
    const current = ++generation.current;
    setReviewing(true);
    setError("");
    setPassword("");
    try {
      const result = await invoke<Plan>("ssh_action_review", {
        profileId: profile.id,
        action,
      });
      if (!mounted.current || current !== generation.current) {
        void invoke("ssh_action_reject", {
          profileId: profile.id,
          planId: result.id,
        }).catch(() => {});
        return;
      }
      pendingPlan.current = result;
      setPlan(result);
    } catch (error) {
      if (mounted.current && current === generation.current)
        setError(safeError(error));
    } finally {
      if (mounted.current && current === generation.current)
        setReviewing(false);
    }
  }
  async function execute() {
    if (!plan || busy) return;
    const approved = plan;
    const secret = password;
    setPassword("");
    setPlan(null);
    pendingPlan.current = null;
    setBusy(true);
    setError("");
    const current = ++generation.current;
    let text = "";
    let ended = false;
    const decoder = new TextDecoder();
    const publish = (state: string) => {
      if (mounted.current && current === generation.current)
        setActivity({ command: approved.command, text, state });
    };
    publish("Running");
    const output = new Channel<StreamEvent>();
    output.onmessage = (event) => {
      if (!mounted.current || current !== generation.current) {
        void streamApi.close(profile.id, event.id).catch(() => {});
        return;
      }
      if (ended) return;
      if (event.type === "data") {
        text = (
          text + decoder.decode(new Uint8Array(event.data), { stream: true })
        ).slice(-131072);
        publish("Running");
        void streamApi
          .ack(profile.id, event.id, event.sequence)
          .catch((error) => {
            text += `\n${safeError(error)}`;
            publish("Output interrupted");
          });
      } else {
        ended = true;
        text += decoder.decode();
        if (reviewSoftware.current)
          setReport(softwareSafety(text, reviewSoftware.current));
        publish(
          `${event.message}${event.code !== null ? ` Exit ${event.code}.` : ""}`,
        );
        stream.current = null;
        setBusy(false);
        void streamApi.close(profile.id, event.id).catch(() => {});
      }
    };
    try {
      const id = await invoke<string>("ssh_action_execute", {
        profileId: profile.id,
        planId: approved.id,
        password: secret,
        output,
      });
      if (!mounted.current || current !== generation.current) {
        void streamApi.close(profile.id, id).catch(() => {});
        return;
      }
      if (!ended) stream.current = id;
    } catch (error) {
      publish(safeError(error));
      if (mounted.current && current === generation.current) setBusy(false);
    }
  }
  const available = [
    "Software",
    "Firewall",
    "Services",
    "Docker",
    "Storage",
  ].includes(tool);
  return (
    <section
      className="space-y-3"
      aria-label={`${profile.name} reviewed inspections`}
    >
      {available && (
        <div className="space-y-3 rounded-lg border p-4">
          <h3 className="text-sm font-medium">
            {tool === "Software"
              ? "Software preflight"
              : tool === "Firewall"
                ? "Privileged UFW inspection"
                : tool === "Services"
                  ? "Service journal"
                  : tool === "Docker"
                    ? "Container logs"
                    : "Directory scan"}
          </h3>
          {tool === "Services" && (
            <Select
              value={serviceOperation}
              onValueChange={(value) => {
                if (
                  [
                    "logs",
                    "start",
                    "stop",
                    "restart",
                    "enable",
                    "disable",
                  ].includes(value ?? "")
                )
                  setServiceOperation(value as typeof serviceOperation);
              }}
            >
              <SelectTrigger aria-label="Service operation">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["logs", "start", "stop", "restart", "enable", "disable"].map(
                  (value) => (
                    <SelectItem
                      key={value}
                      value={value}
                      disabled={value !== "logs"}
                    >
                      {value === "logs"
                        ? "Read logs"
                        : value === "enable"
                          ? "Enable at boot"
                          : value === "disable"
                            ? "Disable at boot"
                            : value}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          )}
          {tool === "Services" && (
            <p className="text-xs text-muted-foreground">
              Read-only mode: service changes stay disabled until
              disposable-server validation is complete. Service journals are
              available below.
            </p>
          )}
          {tool === "Software" && (
            <>
              <Select
                value={software}
                onValueChange={(value) => {
                  if (catalogItems.some((item) => item.id === value))
                    setSoftware(value as CatalogId);
                }}
              >
                <SelectTrigger aria-label="Software preflight target">
                  <SelectValue>
                    {catalogItems.find((item) => item.id === software)?.name}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {catalogItems.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {catalogItems.find((item) => item.id === software)?.scope}
              </p>
              {software === "herdr" && (
                <a
                  className="text-xs text-primary underline"
                  href="https://herdr.dev/docs/install/"
                  target="_blank"
                  rel="noreferrer"
                >
                  Herdr installation reference
                </a>
              )}
            </>
          )}
          {tool !== "Firewall" && tool !== "Software" && (
            <label
              className="block text-xs text-muted-foreground"
              htmlFor={`action-target-${profile.id}`}
            >
              {tool === "Services"
                ? "Exact .service unit"
                : tool === "Docker"
                  ? "Exact container ID"
                  : "Absolute directory path"}
              <Input
                id={`action-target-${profile.id}`}
                className="mt-2"
                value={target}
                maxLength={1024}
                onChange={(event) => setTarget(event.target.value)}
                placeholder={
                  tool === "Services"
                    ? "example.service"
                    : tool === "Docker"
                      ? "Container ID from inspection"
                      : "/srv"
                }
              />
            </label>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={
              !connected ||
              busy ||
              reviewing ||
              (tool !== "Firewall" && tool !== "Software" && !target)
            }
            onClick={() => void review()}
          >
            <ShieldCheck />
            {reviewing ? "Preparing review…" : "Review command"}
          </Button>
        </div>
      )}
      {report && (
        <section
          className="space-y-2 rounded-lg border border-primary/30 p-4"
          aria-label="Software preflight report"
        >
          <h3 className="text-sm font-medium">{report.status}</h3>
          {report.blockers.map((reason) => (
            <p key={reason} className="text-xs text-destructive">
              {reason}
            </p>
          ))}
          {report.unknowns.map((reason) => (
            <p key={reason} className="text-xs text-muted-foreground">
              {reason}
            </p>
          ))}
        </section>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {activity && (
        <section
          className="space-y-3 rounded-lg border bg-sidebar p-4"
          aria-label={`${profile.name} reviewed command activity`}
        >
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium">
              Command activity · {profile.name}
            </p>
            {busy && (
              <Button
                size="xs"
                variant="outline"
                onClick={async () => {
                  generation.current++;
                  const id = stream.current;
                  stream.current = null;
                  setBusy(false);
                  setActivity((old) =>
                    old
                      ? {
                          ...old,
                          state:
                            "Cancelled. Remote process may still be running.",
                        }
                      : old,
                  );
                  if (id) await streamApi.close(profile.id, id).catch(() => {});
                }}
              >
                <Square />
                Cancel
              </Button>
            )}
          </div>
          <p role="status" className="text-xs text-muted-foreground">
            {activity.state}
          </p>
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">
            {activity.command}
          </pre>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">
            {activity.text}
          </pre>
        </section>
      )}
      <Dialog
        open={plan !== null}
        onOpenChange={(open) => {
          if (!open) void dismiss();
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {plan?.privileged
                ? "Approve this sudo command?"
                : "Run this inspection?"}
            </DialogTitle>
            <DialogDescription>
              {plan?.serverName} · {plan?.address}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm">{plan?.purpose}</p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/30 p-3 font-mono text-xs">
            {plan?.command}
          </pre>
          {plan?.evidence && (
            <details>
              <summary className="cursor-pointer text-xs">
                Verified preflight state · rechecked before execution
              </summary>
              <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-all text-xs">
                {plan.evidence}
              </pre>
            </details>
          )}
          {plan?.privileged && (
            <label htmlFor={`sudo-${profile.id}`} className="text-sm">
              Sudo password (when needed)
              <Input
                id={`sudo-${profile.id}`}
                className="mt-2"
                type="password"
                autoComplete="off"
                maxLength={4096}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <span className="mt-2 block text-xs text-muted-foreground">
                Leave blank to use existing sudo authorization. A missing or
                wrong password ends this attempt; review again to retry.
                Passwords are never saved.
              </span>
            </label>
          )}
          <p className="text-xs text-muted-foreground">
            Approval applies only to this server, connection and exact command,
            expires after two minutes, and can be used once. Output stays in
            memory.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => void dismiss()}>
              Reject
            </Button>
            <Button
              disabled={!connected || busy}
              onClick={() => void execute()}
            >
              {plan?.privileged ? "Approve and run" : "Run inspection"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

import { Channel, invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { type ServerProfile, safeError } from "./api";
import { useConfiguration } from "./configuration-context";
import { filesApi, type RemoteDirectory } from "./files-api";
import { Pm2Deployments } from "./pm2-deployments";
import { ProjectCommandRunner, ProjectMenu } from "./pm2-project-actions";

interface Process {
  runFolder?: string;
  id: number;
  name: string;
  status: string;
  uptime: number | null;
  restarts: number;
  cpu: number;
  memory: number;
  folder: string;
}
export function RemotePm2({
  profile,
  connected,
}: {
  profile: ServerProfile;
  connected: boolean;
}) {
  const { connectionId } = useConfiguration();
  const folderId = useId();
  const generation = useRef(0);
  const [availability, setAvailability] = useState("checking");
  const [commandRequest, setCommandRequest] = useState<{
    projects: Process[];
    commands: string[];
    restart: boolean;
  } | null>(null);
  const [editProject, setEditProject] = useState<{
    process: Process;
    nonce: number;
  } | null>(null);
  const [rows, setRows] = useState<Process[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Process | null>(null);
  const [folder, setFolder] = useState("");
  const [steps, setSteps] = useState(
    "git pull --ff-only\nbun install --frozen-lockfile\nbun run build",
  );
  const [directory, setDirectory] = useState<RemoteDirectory | null>(null);
  const [review, setReview] = useState<string[] | null>(null);
  const [restartTargets, setRestartTargets] = useState<Process[]>([]);
  const [checked, setChecked] = useState<number[]>([]);
  const [output, setOutput] = useState("");
  const source = {
    profileId: profile.id,
    profileRevision: profile.revision,
    connectionId,
  };
  const refresh = useCallback(async () => {
    const seq = ++generation.current;
    setBusy(true);
    setError("");
    setAvailability("checking");
    try {
      const result = await invoke<{ installed: boolean; processes: Process[] }>(
        "ssh_pm2_status",
        {
          profileId: profile.id,
          profileRevision: profile.revision,
          connectionId,
        },
      );
      if (seq !== generation.current) return;
      setRows(result.processes);
      setChecked([]);
      setAvailability(
        !result.installed
          ? "missing"
          : result.processes.length
            ? "ready"
            : "empty",
      );
    } catch (e) {
      if (seq === generation.current) {
        setError(safeError(e));
        setAvailability("unknown");
        setRows([]);
      }
    } finally {
      if (seq === generation.current) setBusy(false);
    }
  }, [profile.id, profile.revision, connectionId]);
  useEffect(() => {
    setSelected(null);
    setReview(null);
    setCommandRequest(null);
    setRows([]);
    setChecked([]);
    if (connected && connectionId) void refresh();
    else {
      setAvailability("unknown");
      setBusy(false);
    }
    return () => {
      generation.current++;
    };
  }, [connected, connectionId, refresh]);
  async function logs(process: Process) {
    setError("");
    try {
      const result = await invoke<{ logs: string }>("ssh_pm2_status", {
        ...source,
        process: process.id,
      });
      setOutput(result.logs || "No recent logs.");
    } catch (e) {
      setError(safeError(e));
    }
  }
  async function browse(path: string) {
    try {
      setDirectory(await filesApi.list(profile.id, path));
    } catch (e) {
      setError(safeError(e));
    }
  }
  async function restartMany(targets: Process[]) {
    setBusy(true);
    setError("");
    setRestartTargets(targets);
    try {
      const ids = [];
      for (const process of targets)
        ids.push(
          await invoke<string>("ssh_pm2_review", {
            deployment: {
              ...source,
              folder: process.folder,
              process: process.id,
              name: process.name,
              cwd: process.folder,
              steps: [],
            },
          }),
        );
      setSteps("");
      setReview(ids);
    } catch (e) {
      setError(safeError(e));
    } finally {
      setBusy(false);
    }
  }
  async function prepare(process: Process, restart = false) {
    if (restart) {
      await restartMany([process]);
      return;
    }
    setRestartTargets([]);
    setSelected(process);
    setFolder(process.folder);
    setSteps(
      restart
        ? ""
        : "git pull --ff-only\nbun install --frozen-lockfile\nbun run build",
    );
  }
  async function approve() {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      setReview([
        await invoke<string>("ssh_pm2_review", {
          deployment: {
            ...source,
            folder,
            process: selected.id,
            name: selected.name,
            cwd: selected.folder,
            steps: steps.split("\n").filter((s) => s.trim()),
          },
        }),
      ]);
    } catch (e) {
      setError(safeError(e));
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (!review) return;
    const id = review;
    setReview(null);
    setBusy(true);
    setOutput("");
    const channel = new Channel<Record<string, unknown>>();
    channel.onmessage = (e) =>
      setOutput((old) =>
        (
          old +
          (e.text ??
            e.message ??
            `Step ${Number(e.step ?? 0) + 1}: ${e.status}\n`)
        ).slice(-64000),
      );
    try {
      for (const reviewId of id)
        await invoke("ssh_pm2_apply", { reviewId, output: channel });
      setChecked([]);
      setSelected(null);
      await refresh();
    } catch (e) {
      setError(safeError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-4" aria-label="PM2">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">PM2</h1>
        {checked.length > 0 && (
          <Button
            disabled={busy || !connected}
            variant="outline"
            onClick={() =>
              restartMany(rows.filter((p) => checked.includes(p.id)))
            }
          >
            Restart selected
          </Button>
        )}
        {checked.length > 0 && (
          <Button
            disabled={busy || !connected}
            onClick={() =>
              setCommandRequest({
                projects: rows.filter((p) => checked.includes(p.id)),
                commands: ["git pull --ff-only", "bun i"],
                restart: false,
              })
            }
          >
            Run commands
          </Button>
        )}
        <Button disabled={!connected || busy} onClick={refresh}>
          Refresh
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {availability !== "ready" && (
        <p role="status" className="text-sm text-muted-foreground">
          {!connected
            ? "Connect to check PM2."
            : availability === "checking"
              ? "Checking PM2…"
              : availability === "missing"
                ? "PM2 is not installed for this account."
                : availability === "empty"
                  ? "PM2 is installed, but no managed projects were found for this account."
                  : "Could not check PM2. Try Refresh."}
        </p>
      )}
      {availability === "ready" && (
        <>
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  {[
                    "Process",
                    "Status",
                    "Uptime",
                    "CPU",
                    "Memory",
                    "Restarts",
                    "",
                  ].map((v) => (
                    <th key={v} className="p-2 text-left">
                      {v}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className="border-t">
                    <td className="p-2">
                      <label
                        className="flex items-center gap-2"
                        htmlFor={`pm2-process-${profile.id}-${p.id}`}
                      >
                        <Checkbox
                          id={`pm2-process-${profile.id}-${p.id}`}
                          checked={checked.includes(p.id)}
                          disabled={busy || !connected}
                          onCheckedChange={(v) =>
                            setChecked((old) =>
                              v
                                ? [...old, p.id]
                                : old.filter((id) => id !== p.id),
                            )
                          }
                        />
                        {p.name}
                      </label>
                    </td>
                    <td>{p.status}</td>
                    <td>
                      {p.uptime && p.status === "online"
                        ? `${Math.max(0, Math.floor((Date.now() - p.uptime) / 60000))}m`
                        : "—"}
                    </td>
                    <td>{p.cpu}%</td>
                    <td>{Math.round(p.memory / 1048576)} MB</td>
                    <td>{p.restarts}</td>
                    <td className="flex gap-2 p-2">
                      <ProjectMenu
                        profileId={profile.id}
                        process={p}
                        disabled={busy || !connected}
                        onRun={(commands, restart, runFolder) =>
                          setCommandRequest({
                            projects: [{ ...p, runFolder }],
                            commands,
                            restart,
                          })
                        }
                        onLogs={() => logs(p)}
                        onRestart={() => prepare(p, true)}
                        onEdit={() =>
                          setEditProject({ process: p, nonce: Date.now() })
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {selected && !review && (
            <div className="space-y-3 rounded-lg border p-4">
              <h2>{selected.name}</h2>
              <label htmlFor={folderId} className="block text-sm">
                Project folder
                <Input
                  id={folderId}
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                />
              </label>
              <Button variant="outline" onClick={() => browse(folder)}>
                Browse
              </Button>
              {directory && (
                <div className="space-y-2">
                  <Button
                    variant="outline"
                    onClick={() => browse(directory.parent)}
                  >
                    Parent
                  </Button>
                  <Button
                    onClick={() => {
                      setFolder(directory.path);
                      setDirectory(null);
                    }}
                  >
                    Use this folder
                  </Button>
                  {directory.entries
                    .filter((e) => e.kind === "directory")
                    .map((e) => (
                      <Button
                        className="block"
                        variant="ghost"
                        key={e.path}
                        onClick={() => browse(e.path)}
                      >
                        {e.name}
                      </Button>
                    ))}
                </div>
              )}
              <label className="block text-sm">
                Commands
                <textarea
                  className="mt-2 min-h-32 w-full rounded-md border bg-background p-3 font-mono text-sm"
                  value={steps}
                  onChange={(e) => setSteps(e.target.value)}
                />
              </label>
              <p className="text-xs text-muted-foreground">
                Then restart {selected.name}
              </p>
              <Button disabled={busy || !connected} onClick={approve}>
                Review
              </Button>
            </div>
          )}
          {commandRequest && (
            <ProjectCommandRunner
              profile={profile}
              connectionId={connectionId}
              request={commandRequest}
              onClose={() => setCommandRequest(null)}
            />
          )}
          <Dialog
            open={!!review}
            onOpenChange={(open) => {
              if (!open) setReview(null);
            }}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  {restartTargets.length
                    ? "Restart processes"
                    : `Deploy ${selected?.name}`}
                </DialogTitle>
              </DialogHeader>
              <p className="text-sm">
                {profile.name} ·{" "}
                {restartTargets.length
                  ? restartTargets.map((p) => p.name).join(", ")
                  : folder}
              </p>
              <pre className="overflow-auto whitespace-pre-wrap text-xs">
                {restartTargets.length
                  ? restartTargets
                      .map((p) => `pm2 restart ${p.id} (${p.name})`)
                      .join("\n")
                  : `${steps}\npm2 restart ${selected?.id}`}
              </pre>
              <DialogFooter>
                <Button onClick={() => setReview(null)} variant="outline">
                  Cancel
                </Button>
                <Button onClick={apply}>
                  {restartTargets.length ? "Restart" : "Deploy"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Pm2Deployments seed={editProject} profileId={profile.id} />
        </>
      )}
      {output && (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border p-3 text-xs">
          {output}
        </pre>
      )}
    </section>
  );
}

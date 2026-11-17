import { DragDropProvider } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Channel, invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
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
import { safeError, useConnectionStatuses, useServerProfiles } from "./api";
import { filesApi, type RemoteDirectory } from "./files-api";
export interface Pm2Process {
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
interface Step {
  id: string;
  text: string;
  enabled: boolean;
}
interface Target {
  profileId: string;
  folder: string;
  process: number;
  name: string;
  cwd: string;
}
export interface App {
  id: string;
  name: string;
  steps: Step[];
  targets: Target[];
}
interface Doc {
  version: 1;
  apps: App[];
}
interface Job {
  app: App;
  target: Target;
  profileRevision: string;
  connectionId: string;
  server: string;
  status: string;
}
export function SortableCommand({
  id,
  index,
  children,
}: {
  id: string;
  index: number;
  children: React.ReactNode;
}) {
  const { ref, handleRef, isDragging } = useSortable({
    id,
    index,
    group: "pm2-commands",
    type: "pm2-command",
    accept: "pm2-command",
  });
  return (
    <div ref={ref} className={`flex gap-2 ${isDragging ? "opacity-50" : ""}`}>
      <Button
        ref={handleRef}
        variant="ghost"
        aria-label={`Drag command ${index + 1}`}
      >
        ⠿
      </Button>
      {children}
    </div>
  );
}
const key = ["pm2-workflows"];
export function Pm2Deployments({
  seed,
  profileId,
}: {
  seed?: { process: Pm2Process; nonce: number } | null;
  profileId?: string;
}) {
  const cache = useQueryClient();
  const profiles = useServerProfiles();
  const statuses = useConnectionStatuses(true);
  const saved = useQuery({
    queryKey: key,
    queryFn: () => invoke<string>("ssh_pm2_workflows_load"),
    retry: false,
  });
  const [editing, setEditing] = useState<App | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [review, setReview] = useState<Job[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [output, setOutput] = useState("");
  const requestGeneration = useRef(0);
  const stop = useRef(false);
  const active = useRef(false);
  const [binding, setBinding] = useState<string | null>(null);
  const [processes, setProcesses] = useState<Pm2Process[]>([]);
  const [directory, setDirectory] = useState<RemoteDirectory | null>(null);
  const [browseTarget, setBrowseTarget] = useState<string | null>(null);
  let apps: App[] = [];
  try {
    apps = (JSON.parse(saved.data ?? '{"apps":[]}') as Doc).apps;
  } catch {
    /* native loader validates */
  }
  const seeded = useRef<number | null>(null);
  useEffect(() => {
    if (!seed || !saved.data || !profileId || seeded.current === seed.nonce)
      return;
    seeded.current = seed.nonce;
    const process = seed.process;
    const existing = (JSON.parse(saved.data) as Doc).apps.find((a) =>
      a.targets.some(
        (t) =>
          t.profileId === profileId &&
          t.process === process.id &&
          t.cwd === process.folder,
      ),
    );
    setEditing(
      existing
        ? structuredClone(existing)
        : {
            id: crypto.randomUUID(),
            name: process.name,
            steps: ["git pull --ff-only", "bun i", "bun run build"].map(
              (text) => ({ id: crypto.randomUUID(), text, enabled: true }),
            ),
            targets: [
              {
                profileId,
                folder: process.folder,
                cwd: process.folder,
                name: process.name,
                process: process.id,
              },
            ],
          },
    );
  }, [seed, saved.data, profileId]);
  const connected = (id: string) =>
    statuses.data?.find((s) => s.profileId === id && s.status === "connected")
      ?.connectionId;
  function patch(app: App) {
    setEditing(app);
  }
  async function save() {
    if (!editing || !saved.data) return;
    setSaving(true);
    setError("");
    try {
      const value = JSON.stringify({
        version: 1,
        apps: [...apps.filter((a) => a.id !== editing.id), editing],
      });
      await invoke("ssh_pm2_workflows_save", { expected: saved.data, value });
      cache.setQueryData(key, value);
      setEditing(null);
    } catch (e) {
      setError(safeError(e));
    } finally {
      setSaving(false);
    }
  }
  async function remove(app: App) {
    if (!saved.data) return;
    try {
      const value = JSON.stringify({
        version: 1,
        apps: apps.filter((a) => a.id !== app.id),
      });
      await invoke("ssh_pm2_workflows_save", { expected: saved.data, value });
      cache.setQueryData(key, value);
    } catch (e) {
      setError(safeError(e));
    }
  }
  async function bind(id: string) {
    const p = profiles.data?.find((p) => p.id === id);
    if (!p) return;
    const generation = ++requestGeneration.current;
    setBinding(id);
    setProcesses([]);
    try {
      const result = await invoke<{ processes: Pm2Process[] }>(
        "ssh_pm2_status",
        {
          profileId: id,
          profileRevision: p.revision,
          connectionId: connected(id),
        },
      );
      if (generation === requestGeneration.current)
        setProcesses(result.processes);
    } catch (e) {
      setError(safeError(e));
    }
  }
  async function browse(id: string, path: string) {
    setBrowseTarget(id);
    try {
      setDirectory(await filesApi.list(id, path));
    } catch (e) {
      setError(safeError(e));
    }
  }
  function prepare() {
    setError("");
    const selected: Job[] = [];
    for (const p of profiles.data ?? []) {
      for (const app of apps) {
        for (const target of app.targets) {
          if (
            target.profileId !== p.id ||
            !chosen.includes(`${app.id}:${p.id}`)
          )
            continue;
          const connectionId = connected(p.id);
          if (!connectionId) {
            setError(`Connect to ${p.name} first.`);
            return;
          }
          selected.push({
            app: structuredClone(app),
            target: { ...target },
            profileRevision: p.revision,
            connectionId,
            server: p.name,
            status: "Queued",
          });
        }
      }
    }
    setReview(selected);
  }
  async function run(list: Job[]) {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setPaused(false);
    setReview(null);
    stop.current = false;
    setJobs(list);
    setError("");
    try {
      for (let index = 0; index < list.length; index++) {
        if (stop.current) {
          setPaused(true);
          continue;
        }
        const job = list[index];
        if (job.status === "Succeeded" || job.status === "Skipped") continue;
        const update = (status: string) => {
          job.status = status;
          setJobs([...list]);
        };
        update("Deploying");
        try {
          const reviewId = await invoke<string>("ssh_pm2_review", {
            deployment: {
              profileId: job.target.profileId,
              profileRevision: job.profileRevision,
              connectionId: job.connectionId,
              folder: job.target.folder,
              process: job.target.process,
              name: job.target.name,
              cwd: job.target.cwd,
              steps: job.app.steps.filter((s) => s.enabled).map((s) => s.text),
            },
          });
          const channel = new Channel<{
            status: string;
            step?: number;
            text?: string;
            message?: string;
          }>();
          channel.onmessage = (e) => {
            if (e.step !== undefined && e.status === "running")
              update(
                `Step ${e.step + 1}/${job.app.steps.filter((s) => s.enabled).length}`,
              );
            setOutput((old) =>
              (
                old +
                (e.text ??
                  e.message ??
                  `${job.server} / ${job.app.name}: ${e.status}\n`)
              ).slice(-64000),
            );
          };
          await invoke("ssh_pm2_apply", { reviewId, output: channel });
          update("Succeeded");
        } catch (e) {
          update("Failed");
          setError(safeError(e));
          setPaused(true);
        }
      }
    } finally {
      setBusy(false);
      active.current = false;
    }
  }
  return (
    <section className="space-y-3 border-t pt-4" aria-label="Deployments">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto font-semibold">Deployments</h2>
        <Button
          variant="outline"
          disabled={busy || saving || !saved.data}
          onClick={() =>
            setEditing({
              id: crypto.randomUUID(),
              name: "",
              steps: [
                {
                  id: crypto.randomUUID(),
                  text: "git pull --ff-only",
                  enabled: true,
                },
                {
                  id: crypto.randomUUID(),
                  text: "bun install --frozen-lockfile",
                  enabled: true,
                },
                {
                  id: crypto.randomUUID(),
                  text: "bun run build",
                  enabled: true,
                },
              ],
              targets: [],
            })
          }
        >
          New app
        </Button>
        <Button disabled={busy || !chosen.length} onClick={prepare}>
          Deploy selected
        </Button>
      </div>
      {(error || saved.error) && (
        <p role="alert" className="text-sm text-destructive">
          {error || safeError(saved.error)}
        </p>
      )}
      {apps.map((app) => (
        <div className="rounded-lg border p-3" key={app.id}>
          <div className="flex items-center gap-2">
            <strong className="mr-auto text-sm">{app.name}</strong>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setEditing(structuredClone(app))}
            >
              Edit
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => remove(app)}>
              Remove workflow
            </Button>
          </div>
          <div className="flex flex-wrap gap-4">
            {app.targets.map((t) => (
              <label
                className="flex items-center gap-2 text-sm"
                htmlFor={`pm2-${app.id}-${t.profileId}`}
                key={t.profileId}
              >
                <Checkbox
                  id={`pm2-${app.id}-${t.profileId}`}
                  checked={chosen.includes(`${app.id}:${t.profileId}`)}
                  disabled={busy}
                  onCheckedChange={(v) =>
                    setChosen((old) =>
                      v
                        ? [...old, `${app.id}:${t.profileId}`]
                        : old.filter((id) => id !== `${app.id}:${t.profileId}`),
                    )
                  }
                />
                {profiles.data?.find((p) => p.id === t.profileId)?.name ??
                  "Unavailable server"}
                <span className="text-xs text-muted-foreground">{t.name}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
      {editing && (
        <div className="space-y-3 rounded-lg border p-4">
          <Input
            aria-label="App name"
            placeholder="App name"
            value={editing.name}
            onChange={(e) => patch({ ...editing, name: e.target.value })}
          />
          <DragDropProvider
            onDragEnd={(event) => {
              const source = event.operation.source;
              if (
                event.canceled ||
                !isSortable(source) ||
                source.index === source.initialIndex
              )
                return;
              const steps = [...editing.steps];
              const from = steps.findIndex((s) => s.id === String(source.id));
              if (from < 0 || source.index < 0 || source.index >= steps.length)
                return;
              const [step] = steps.splice(from, 1);
              steps.splice(source.index, 0, step);
              patch({ ...editing, steps });
            }}
          >
            <div className="space-y-2">
              {editing.steps.map((s, i) => (
                <SortableCommand key={s.id} id={s.id} index={i}>
                  <Checkbox
                    aria-label={`Enable step ${i + 1}`}
                    checked={s.enabled}
                    onCheckedChange={(v) =>
                      patch({
                        ...editing,
                        steps: editing.steps.map((a, j) =>
                          j === i ? { ...a, enabled: !!v } : a,
                        ),
                      })
                    }
                  />
                  <Input
                    aria-label={`Command ${i + 1}`}
                    value={s.text}
                    onChange={(e) =>
                      patch({
                        ...editing,
                        steps: editing.steps.map((a, j) =>
                          j === i ? { ...a, text: e.target.value } : a,
                        ),
                      })
                    }
                  />
                  <Button
                    aria-label={`Move step ${i + 1} up`}
                    variant="ghost"
                    disabled={i === 0}
                    onClick={() => {
                      const steps = [...editing.steps];
                      [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]];
                      patch({ ...editing, steps });
                    }}
                  >
                    ↑
                  </Button>
                  <Button
                    aria-label={`Remove step ${i + 1}`}
                    variant="ghost"
                    onClick={() =>
                      patch({
                        ...editing,
                        steps: editing.steps.filter((_, j) => j !== i),
                      })
                    }
                  >
                    ×
                  </Button>
                </SortableCommand>
              ))}
            </div>
          </DragDropProvider>
          <Button
            variant="outline"
            disabled={editing.steps.length >= 20}
            onClick={() =>
              patch({
                ...editing,
                steps: [
                  ...editing.steps,
                  { id: crypto.randomUUID(), text: "", enabled: true },
                ],
              })
            }
          >
            Add command
          </Button>
          <p className="text-xs text-muted-foreground">
            Then restart the selected PM2 process. Save commands without
            secrets.
          </p>
          <div className="flex flex-wrap gap-2">
            {profiles.data?.map((p) => (
              <Button
                variant="outline"
                key={p.id}
                disabled={!connected(p.id)}
                onClick={() => bind(p.id)}
              >
                {p.name}
              </Button>
            ))}
          </div>
          {binding && (
            <div className="flex flex-wrap gap-2">
              {processes.map((p) => (
                <Button
                  variant="outline"
                  key={p.id}
                  onClick={() => {
                    patch({
                      ...editing,
                      targets: [
                        ...editing.targets.filter(
                          (t) => t.profileId !== binding,
                        ),
                        {
                          profileId: binding,
                          folder: p.folder,
                          process: p.id,
                          name: p.name,
                          cwd: p.folder,
                        },
                      ],
                    });
                    setBinding(null);
                  }}
                >
                  {p.name} · {p.id}
                </Button>
              ))}
            </div>
          )}
          {editing.targets.map((t) => (
            <div key={t.profileId} className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-sm">
                  {profiles.data?.find((p) => p.id === t.profileId)?.name} ·{" "}
                  {t.name}
                </span>
                <Button
                  variant="ghost"
                  onClick={() =>
                    patch({
                      ...editing,
                      targets: editing.targets.filter(
                        (a) => a.profileId !== t.profileId,
                      ),
                    })
                  }
                >
                  Remove
                </Button>
              </div>
              <div className="flex gap-2">
                <Input
                  aria-label={`Project folder for ${t.name}`}
                  value={t.folder}
                  onChange={(e) =>
                    patch({
                      ...editing,
                      targets: editing.targets.map((a) =>
                        a.profileId === t.profileId
                          ? { ...a, folder: e.target.value }
                          : a,
                      ),
                    })
                  }
                />
                <Button
                  variant="outline"
                  onClick={() => browse(t.profileId, t.folder)}
                >
                  Browse
                </Button>
              </div>
            </div>
          ))}
          {directory && (
            <div className="space-y-2 rounded border p-2">
              <p className="break-all text-xs">{directory.path}</p>
              <Button
                variant="ghost"
                onClick={() => browse(browseTarget ?? "", directory.parent)}
              >
                Parent
              </Button>
              <Button
                onClick={() => {
                  patch({
                    ...editing,
                    targets: editing.targets.map((t) =>
                      t.profileId === browseTarget
                        ? { ...t, folder: directory.path }
                        : t,
                    ),
                  });
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
                    onClick={() => browse(browseTarget ?? "", e.path)}
                  >
                    {e.name}
                  </Button>
                ))}
            </div>
          )}
          <div className="flex gap-2">
            <Button
              disabled={
                saving || !editing.name.trim() || !editing.targets.length
              }
              onClick={save}
            >
              {saving ? "Saving…" : "Save workflow"}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setEditing(null);
                setDirectory(null);
                setBinding(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {jobs.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            {busy && (
              <Button
                variant="outline"
                onClick={() => {
                  stop.current = true;
                }}
              >
                Stop after current
              </Button>
            )}
            {paused && !busy && (
              <>
                <Button
                  onClick={() =>
                    run(
                      jobs.map((j) =>
                        j.status === "Failed" ? { ...j, status: "Queued" } : j,
                      ),
                    )
                  }
                >
                  Retry full workflow
                </Button>
                <Button
                  variant="outline"
                  onClick={() =>
                    run(
                      jobs.map((j) =>
                        j.status === "Failed" ? { ...j, status: "Skipped" } : j,
                      ),
                    )
                  }
                >
                  Skip failed and continue
                </Button>
              </>
            )}
          </div>
          {jobs.map((j) => (
            <div
              className="flex justify-between text-sm"
              key={j.app.id + j.target.profileId}
            >
              <span>
                {j.server} · {j.app.name}
              </span>
              <span>{j.status}</span>
            </div>
          ))}
        </div>
      )}
      {output && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border p-3 text-xs">
          {output}
        </pre>
      )}
      <Dialog
        open={!!review}
        onOpenChange={(v) => {
          if (!v) setReview(null);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-auto">
          <DialogHeader>
            <DialogTitle>Deploy selected</DialogTitle>
          </DialogHeader>
          {review?.map((j) => (
            <div
              key={j.app.id + j.target.profileId}
              className="space-y-1 border-b py-2"
            >
              <p className="text-sm">
                {j.server} · {j.app.name}
              </p>
              <p className="break-all text-xs text-muted-foreground">
                {j.target.folder}
              </p>
              <pre className="whitespace-pre-wrap break-all text-xs">
                {j.app.steps
                  .filter((s) => s.enabled)
                  .map((s) => s.text)
                  .join("\n")}
                {"\n"}pm2 restart {j.target.process} ({j.target.name})
              </pre>
            </div>
          ))}
          <DialogFooter>
            <Button variant="outline" onClick={() => setReview(null)}>
              Cancel
            </Button>
            <Button onClick={() => review && run(review)}>Deploy</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

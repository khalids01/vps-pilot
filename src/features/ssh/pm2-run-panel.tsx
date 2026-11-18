import { Channel, invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type ServerProfile, safeError } from "./api";
import type { Pm2Process } from "./pm2-deployments";

type Status = "Queued" | "Running" | "Succeeded" | "Failed" | "Skipped";
interface Step {
  id: string;
  command: string;
  status: Status;
  output: string;
  started?: number;
  duration?: number;
  code?: number;
}
interface Run {
  id: string;
  name: string;
  folder: string;
  status: Status;
  steps: Step[];
  error?: string;
  project: Pm2Process;
  commands: string[];
  restart: boolean;
  profile: ServerProfile;
  connectionId: string | null | undefined;
}
interface Event {
  step?: number;
  status: string;
  text?: string;
  message?: string;
  code?: number;
}
export function usePm2Runs(
  profile: ServerProfile,
  connectionId: string | null | undefined,
) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const queue = useRef(Promise.resolve());
  const count = useRef(0);
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selected)
      panelRef.current?.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
  }, [selected]);
  function patch(id: string, update: (run: Run) => Run) {
    setRuns((old) => old.map((run) => (run.id === id ? update(run) : run)));
  }
  async function execute(run: Run) {
    let current = 0;
    patch(run.id, (r) => ({ ...r, status: "Running" }));
    try {
      const reviewId = await invoke<string>("ssh_pm2_review", {
        deployment: {
          profileId: run.profile.id,
          profileRevision: run.profile.revision,
          connectionId: run.connectionId,
          folder: run.folder,
          process: run.project.id,
          name: run.project.name,
          cwd: run.project.folder,
          steps: run.commands,
          restart: run.restart,
        },
      });
      const output = new Channel<Event>();
      output.onmessage = (event) => {
        if (
          event.step !== undefined &&
          event.step >= 0 &&
          event.step < run.commands.length
        )
          current = event.step;
        const index = current;
        patch(run.id, (r) => ({
          ...r,
          steps: r.steps.map((step, i) => {
            if (i !== index) return step;
            const status =
              event.status === "running"
                ? "Running"
                : event.status === "succeeded"
                  ? "Succeeded"
                  : event.status === "failed"
                    ? "Failed"
                    : step.status;
            return {
              ...step,
              status,
              started: step.started ?? Date.now(),
              duration:
                status === "Succeeded" || status === "Failed"
                  ? Date.now() - (step.started ?? Date.now())
                  : step.duration,
              code: event.code ?? step.code,
              output: (step.output + (event.text ?? event.message ?? "")).slice(
                -16000,
              ),
            };
          }),
        }));
        if (
          event.status === "succeeded" &&
          event.step === run.commands.length - 1 &&
          run.restart
        ) {
          current = run.commands.length;
          patch(run.id, (r) => ({
            ...r,
            steps: r.steps.map((s, i) =>
              i === current
                ? { ...s, status: "Running", started: Date.now() }
                : s,
            ),
          }));
        }
      };
      await invoke("ssh_pm2_apply", { reviewId, output });
      patch(run.id, (r) => ({
        ...r,
        status: "Succeeded",
        steps: r.steps.map((s) => ({
          ...s,
          status: "Succeeded",
          duration: s.duration ?? Date.now() - (s.started ?? Date.now()),
        })),
      }));
    } catch (error) {
      patch(run.id, (r) => ({
        ...r,
        status: "Failed",
        error: safeError(error),
        steps: r.steps.map((s, i) => ({
          ...s,
          status:
            i === current
              ? "Failed"
              : s.status === "Queued" || s.status === "Running"
                ? "Skipped"
                : s.status,
        })),
      }));
    }
  }
  function start(projects: Pm2Process[], commands: string[], restart: boolean) {
    if (count.current + projects.length > 30)
      throw Error("Close finished run tabs before starting more.");
    if (!commands.length || commands.length > 20 || !connectionId)
      throw Error("Choose commands and connect to the server first.");
    const next: Run[] = projects.map((project) => ({
      id: crypto.randomUUID(),
      name: project.name,
      folder: project.runFolder ?? project.folder,
      status: "Queued",
      steps: [
        ...commands,
        ...(restart ? [`pm2 restart ${project.id}`] : []),
      ].map((command) => ({
        id: crypto.randomUUID(),
        command,
        status: "Queued",
        output: "",
      })),
      project,
      commands: [...commands],
      restart,
      profile: { ...profile },
      connectionId,
    }));
    count.current += next.length;
    setRuns((old) => [...old, ...next]);
    setSelected(next[0]?.id ?? null);
    setCollapsed(false);
    for (const run of next)
      queue.current = queue.current.then(() => execute(run));
  }
  const panel =
    runs.length > 0 ? (
      <section
        ref={panelRef}
        aria-label="Command runs"
        className="min-w-0 rounded-xl border bg-card"
      >
        <div className="flex items-center justify-between border-b px-3 py-2">
          <h2 className="text-sm font-medium">Command runs</h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? "Expand" : "Collapse"}
          </Button>
        </div>
        <div hidden={collapsed}>
          <Tabs
            value={selected}
            onValueChange={(value) => setSelected(String(value))}
          >
            <TabsList className="overflow-x-auto border-b px-2">
              {runs.map((run, i) => (
                <TabsTrigger key={run.id} value={run.id} className="shrink-0">
                  {run.name} · {i + 1}{" "}
                  <span
                    className={
                      run.status === "Failed"
                        ? "text-destructive"
                        : "text-muted-foreground"
                    }
                  >
                    {run.status}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>
            {runs.map((run) => (
              <TabsContent key={run.id} value={run.id}>
                <div
                  className="min-h-48 max-h-[65vh] resize-y overflow-auto p-3"
                  style={{ height: "22rem" }}
                >
                  <p className="mb-3 break-all text-xs text-muted-foreground">
                    {run.profile.name} · {run.folder}
                  </p>
                  {run.steps.map((step, i) => (
                    <details
                      key={`${step.id}-${step.status}`}
                      open={
                        step.status === "Running" || step.status === "Failed"
                      }
                      className="mb-2 rounded-md border"
                    >
                      <summary className="cursor-pointer break-all px-3 py-2 font-mono text-xs">
                        {i + 1}. {step.command} ·{" "}
                        <span
                          className={
                            step.status === "Failed"
                              ? "text-destructive"
                              : "text-muted-foreground"
                          }
                        >
                          {step.status}
                        </span>
                        {step.duration !== undefined
                          ? ` · ${(step.duration / 1000).toFixed(1)}s`
                          : ""}
                        {step.code !== undefined ? ` · exit ${step.code}` : ""}
                      </summary>
                      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all border-t bg-background p-3 text-xs">
                        {step.output ||
                          (step.status === "Running"
                            ? "Waiting for output…"
                            : "No output.")}
                      </pre>
                    </details>
                  ))}
                  {run.error && (
                    <p
                      role="alert"
                      className="break-all text-xs text-destructive"
                    >
                      {run.error}
                    </p>
                  )}
                  <div className="mt-3 flex gap-2">
                    {run.status === "Failed" && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={
                          runs.length >= 30 ||
                          run.connectionId !== connectionId ||
                          run.profile.revision !== profile.revision
                        }
                        onClick={() =>
                          start([run.project], run.commands, run.restart)
                        }
                      >
                        Retry project
                      </Button>
                    )}
                    {(run.status === "Succeeded" ||
                      run.status === "Failed") && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          const next = runs.filter((r) => r.id !== run.id);
                          setRuns(next);
                          count.current--;
                          setSelected(next[next.length - 1]?.id ?? null);
                        }}
                      >
                        Close run
                      </Button>
                    )}
                  </div>
                </div>
              </TabsContent>
            ))}
          </Tabs>
        </div>
      </section>
    ) : null;
  return { start, panel };
}

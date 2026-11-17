import { DragDropProvider } from "@dnd-kit/react";
import { isSortable } from "@dnd-kit/react/sortable";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Channel, invoke } from "@tauri-apps/api/core";
import { useState } from "react";
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
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { type ServerProfile, safeError } from "./api";
import type { App, Pm2Process } from "./pm2-deployments";
import { SortableCommand } from "./pm2-deployments";
export function useProjectCommands() {
  return useQuery({
    queryKey: ["pm2-workflows"],
    queryFn: () => invoke<string>("ssh_pm2_workflows_load"),
    retry: false,
  });
}
export function ProjectMenu({
  profileId,
  process,
  disabled,
  onRun,
  onLogs,
  onRestart,
  onEdit,
}: {
  profileId: string;
  process: Pm2Process;
  disabled: boolean;
  onRun: (commands: string[], restart: boolean, runFolder?: string) => void;
  onLogs: () => void;
  onRestart: () => void;
  onEdit: () => void;
}) {
  const saved = useProjectCommands();
  let commands: string[] = [];
  let runFolder = process.folder;
  let individual: string[] = [];
  try {
    const apps: App[] = JSON.parse(saved.data ?? '{"apps":[]}').apps;
    const app = apps.find((a: App) =>
      a.targets.some(
        (t: App["targets"][number]) =>
          t.profileId === profileId &&
          t.process === process.id &&
          t.cwd === process.folder,
      ),
    );
    individual = app?.steps.map((s) => s.text) ?? [];
    runFolder =
      app?.targets.find(
        (t) => t.profileId === profileId && t.process === process.id,
      )?.folder ?? process.folder;
    commands = app?.steps
      .filter((s: App["steps"][number]) => s.enabled)
      .map((s: App["steps"][number]) => s.text) ?? [
      "git pull --ff-only",
      "bun i",
      "bun run build",
    ];
  } catch {}
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant="outline"
            disabled={disabled}
            aria-label={`Actions for ${process.name}`}
          />
        }
      >
        Actions
      </MenuTrigger>
      <MenuContent>
        <MenuItem onClick={() => onRun(commands, true, runFolder)}>
          Deploy
        </MenuItem>
        {[...new Set(individual.length ? individual : commands)].map((c) => (
          <MenuItem key={c} onClick={() => onRun([c], false, runFolder)}>
            {c}
          </MenuItem>
        ))}
        <MenuItem onClick={onRestart}>Restart</MenuItem>
        <MenuItem onClick={onLogs}>Logs</MenuItem>
        <MenuItem onClick={onEdit}>Edit commands</MenuItem>
      </MenuContent>
    </Menu>
  );
}
export function ProjectCommandRunner({
  profile,
  connectionId,
  request,
  onClose,
}: {
  profile: ServerProfile;
  connectionId: string | null | undefined;
  request: { projects: Pm2Process[]; commands: string[]; restart: boolean };
  onClose: () => void;
}) {
  const saved = useProjectCommands();
  const cache = useQueryClient();
  const [list, setList] = useState(
    request.commands.map((text) => ({ id: crypto.randomUUID(), text })),
  );
  const text = list.map((s) => s.text).join("\n");
  const setText = (value: string) =>
    setList(
      value.split("\n").map((text) => ({ id: crypto.randomUUID(), text })),
    );
  const [restart, setRestart] = useState(request.restart);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [output, setOutput] = useState("");
  const [results, setResults] = useState<Record<number, string>>({});
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  async function save() {
    if (!saved.data || !name.trim()) return;
    setSaving(true);
    try {
      const doc = JSON.parse(saved.data);
      doc.apps.push({
        id: crypto.randomUUID(),
        name,
        steps: text
          .split("\n")
          .filter((s) => s.trim())
          .map((text) => ({ id: crypto.randomUUID(), text, enabled: true })),
        targets: [],
      });
      const value = JSON.stringify(doc);
      await invoke("ssh_pm2_workflows_save", { expected: saved.data, value });
      cache.setQueryData(["pm2-workflows"], value);
      setName("");
    } catch (e) {
      setError(safeError(e));
    } finally {
      setSaving(false);
    }
  }
  async function run(retry = false) {
    setBusy(true);
    setError("");
    for (const p of request.projects) {
      if (retry && results[p.id] !== "Failed") continue;
      setResults((old) => ({ ...old, [p.id]: "Running" }));
      try {
        const reviewId = await invoke<string>("ssh_pm2_review", {
          deployment: {
            profileId: profile.id,
            profileRevision: profile.revision,
            connectionId,
            folder: p.runFolder ?? p.folder,
            process: p.id,
            name: p.name,
            cwd: p.folder,
            steps: text.split("\n").filter((s) => s.trim()),
            restart,
          },
        });
        const output = new Channel<{
          step?: number;
          status: string;
          text?: string;
          message?: string;
        }>();
        output.onmessage = (e) =>
          setOutput((old) =>
            (
              old +
              (e.text ??
                e.message ??
                `${p.name} · ${e.step === undefined ? e.status : `step ${e.step + 1}: ${e.status}`}\n`)
            ).slice(-64000),
          );
        await invoke("ssh_pm2_apply", { reviewId, output });
        setResults((old) => ({ ...old, [p.id]: "Succeeded" }));
      } catch (e) {
        setResults((old) => ({ ...old, [p.id]: "Failed" }));
        setError(safeError(e));
      }
    }
    setBusy(false);
  }
  let templates: App[] = [];
  try {
    templates = JSON.parse(saved.data ?? '{"apps":[]}').apps;
  } catch {}
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[85dvh] overflow-auto">
        <DialogHeader>
          <DialogTitle>
            Run commands · {request.projects.length} projects
          </DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">{profile.name}</p>
        {request.projects.map((p) => (
          <div key={p.id} className="flex justify-between gap-2 text-sm">
            <span>
              {p.name}
              <span className="block break-all text-xs text-muted-foreground">
                {p.folder}
              </span>
            </span>
            <span>{results[p.id]}</span>
          </div>
        ))}
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="outline"
                disabled={busy || Object.keys(results).length > 0}
              />
            }
          >
            Use saved list
          </MenuTrigger>
          <MenuContent>
            {templates.map((a) => (
              <MenuItem
                key={a.id}
                onClick={() =>
                  setText(
                    a.steps
                      .filter((s: App["steps"][number]) => s.enabled)
                      .map((s: App["steps"][number]) => s.text)
                      .join("\n"),
                  )
                }
              >
                {a.name}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
        <DragDropProvider
          onDragEnd={(event) => {
            const source = event.operation.source;
            if (
              busy ||
              Object.keys(results).length ||
              event.canceled ||
              !isSortable(source)
            )
              return;
            const next = [...list];
            const from = next.findIndex((s) => s.id === String(source.id));
            if (from < 0 || source.index < 0 || source.index >= next.length)
              return;
            const [item] = next.splice(from, 1);
            next.splice(source.index, 0, item);
            setList(next);
          }}
        >
          <div className="space-y-2">
            {list.map((s, i) => (
              <SortableCommand key={s.id} id={s.id} index={i}>
                <Input
                  aria-label={`Run command ${i + 1}`}
                  disabled={busy || Object.keys(results).length > 0}
                  value={s.text}
                  onChange={(e) =>
                    setList((old) =>
                      old.map((a) =>
                        a.id === s.id ? { ...a, text: e.target.value } : a,
                      ),
                    )
                  }
                />
                <Button
                  aria-label={`Move run command ${i + 1} up`}
                  variant="ghost"
                  disabled={busy || i === 0 || Object.keys(results).length > 0}
                  onClick={() => {
                    const next = [...list];
                    [next[i - 1], next[i]] = [next[i], next[i - 1]];
                    setList(next);
                  }}
                >
                  ↑
                </Button>
                <Button
                  aria-label={`Remove run command ${i + 1}`}
                  variant="ghost"
                  disabled={busy || Object.keys(results).length > 0}
                  onClick={() =>
                    setList((old) => old.filter((a) => a.id !== s.id))
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
          disabled={
            busy || Object.keys(results).length > 0 || list.length >= 20
          }
          onClick={() =>
            setList((old) => [...old, { id: crypto.randomUUID(), text: "" }])
          }
        >
          Add command
        </Button>
        <label
          className="flex items-center gap-2 text-sm"
          htmlFor="pm2-run-restart"
        >
          <Checkbox
            id="pm2-run-restart"
            disabled={busy || Object.keys(results).length > 0}
            checked={restart}
            onCheckedChange={(v) => setRestart(!!v)}
          />
          Restart after commands
        </label>
        <div className="flex gap-2">
          <Input
            aria-label="Command list name"
            placeholder="List name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button
            variant="outline"
            disabled={saving || !name.trim() || busy}
            onClick={save}
          >
            Save list
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {output && (
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">
            {output}
          </pre>
        )}
        <DialogFooter>
          <Button disabled={busy} variant="outline" onClick={onClose}>
            Done
          </Button>
          {Object.values(results).includes("Failed") ? (
            <Button disabled={busy} onClick={() => run(true)}>
              Retry failed projects
            </Button>
          ) : (
            <Button
              disabled={busy || Object.keys(results).length > 0 || !text.trim()}
              onClick={() => run()}
            >
              Run commands
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

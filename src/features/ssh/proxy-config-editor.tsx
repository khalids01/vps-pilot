import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProxyTextEditor as TextEditor } from "./proxy-text-editor";
import type {
  ProxyFile,
  ProxyInstance,
  ProxyIntent,
} from "./proxy-workspace-types";

export function ProxyConfigEditor({
  instance,
  files,
  treeRevision,
  busy,
  onIntent,
  onClose,
}: {
  instance: ProxyInstance;
  files: ProxyFile[];
  treeRevision: string;
  busy: boolean;
  onIntent: (intent: ProxyIntent) => void;
  onClose: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [draftRevisions, setDraftRevisions] = useState<Record<string, string>>(
    {},
  );
  useEffect(() => {
    setDrafts((old) =>
      Object.fromEntries(
        Object.entries(old).filter(
          ([path, content]) =>
            !files.some(
              (file) => file.path === path && file.content === content,
            ),
        ),
      ),
    );
    setAdded((old) =>
      old.filter(
        (file) => !files.some((current) => current.path === file.path),
      ),
    );
  }, [files]);
  const [added, setAdded] = useState<ProxyFile[]>([]);
  const [selected, setSelected] = useState(
    files.find((f) => f.path.endsWith(instance.config.split("/").pop() ?? ""))
      ?.path ??
      files[0]?.path ??
      "",
  );
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState("");
  const [template, setTemplate] = useState("blank");
  const all = [...files, ...added];
  const current = all.find((f) => f.path === selected);
  function add() {
    const next = path.trim();
    if (!next || all.some((f) => f.path === next)) return;
    let content = "";
    if (template !== "blank") {
      if (instance.manager === "caddy")
        content =
          template === "static"
            ? "example.com {\n\troot * /var/www/site/dist\n\ttry_files {path} /index.html\n\tfile_server\n}\n"
            : "example.com {\n\treverse_proxy 127.0.0.1:3000\n}\n";
      if (instance.manager === "nginx")
        content =
          template === "static"
            ? "server {\n    listen 80;\n    server_name example.com;\n    root /var/www/site/dist;\n    location / {\n        try_files $uri $uri/ /index.html;\n    }\n}\n"
            : "server {\n    listen 80;\n    server_name example.com;\n    location / {\n        proxy_pass http://127.0.0.1:3000;\n        proxy_set_header Host $host;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;\n    }\n}\n";
      if (instance.manager === "traefik")
        content =
          'http:\n  routers:\n    app:\n      rule: "Host(`example.com`)"\n      service: app\n  services:\n    app:\n      loadBalancer:\n        servers:\n          - url: "http://127.0.0.1:3000"\n';
    }
    setAdded((old) => [
      ...old,
      { path: next, content: "", revision: "missing", editable: true },
    ]);
    setDrafts((old) => ({ ...old, [next]: content }));
    setSelected(next);
    setAdding(false);
  }
  return (
    <section
      aria-label="Proxy configurations"
      className="min-w-0 rounded-xl border bg-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
        <h2 className="font-medium">{instance.name} · Configurations</h2>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!instance.editable || busy}
            onClick={() => {
              setAdding(!adding);
              const root = instance.roots.find((r) => r.directory)?.host ?? "";
              setPath(
                `${root}/${instance.manager === "nginx" ? "conf.d/site.conf" : instance.manager === "caddy" ? "site.caddy" : "dynamic/site.yml"}`,
              );
            }}
          >
            Add config
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close editor
          </Button>
        </div>
      </div>
      {adding && (
        <div className="space-y-2 border-b p-3">
          <div className="flex flex-wrap gap-2">
            <Input
              aria-label="New proxy config path"
              className="min-w-48 flex-1"
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
            <Select
              value={template}
              onValueChange={(value) => {
                if (value) setTemplate(value);
              }}
            >
              <SelectTrigger aria-label="Configuration template">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="blank">Blank</SelectItem>
                <SelectItem value="proxy">Reverse proxy</SelectItem>
                {instance.manager !== "traefik" && (
                  <SelectItem value="static">Static site / React</SelectItem>
                )}
              </SelectContent>
            </Select>
            <Button
              disabled={!path.trim() || all.some((f) => f.path === path.trim())}
              onClick={add}
            >
              Create draft
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Use an existing configuration directory. New files must be included
            by the proxy; templates contain example domains and paths.
          </p>
        </div>
      )}
      <div className="grid min-w-0 md:grid-cols-[14rem_minmax(0,1fr)]">
        <nav
          aria-label="Proxy configuration files"
          className="max-h-48 overflow-auto border-b p-2 md:max-h-[36rem] md:border-r md:border-b-0"
        >
          {all.map((file) => (
            <Button
              key={file.path}
              variant={selected === file.path ? "secondary" : "ghost"}
              className="h-auto w-full justify-start whitespace-normal break-all px-2 py-2 text-left text-xs"
              onClick={() => setSelected(file.path)}
            >
              {file.path}
              {drafts[file.path] !== undefined &&
              drafts[file.path] !== file.content
                ? " *"
                : ""}
              {file.target ? " ↗" : ""}
            </Button>
          ))}
        </nav>
        <div className="min-w-0 p-3">
          {current ? (
            <Tabs
              value={selected}
              onValueChange={(value) => setSelected(String(value))}
            >
              <TabsList className="overflow-x-auto border-b">
                {all
                  .filter(
                    (f) => f.path === selected || drafts[f.path] !== undefined,
                  )
                  .map((f) => (
                    <TabsTrigger
                      key={f.path}
                      value={f.path}
                      className="shrink-0 text-xs"
                    >
                      {f.path.split("/").pop()}
                      {drafts[f.path] !== undefined &&
                      drafts[f.path] !== f.content
                        ? " *"
                        : ""}
                    </TabsTrigger>
                  ))}
              </TabsList>
              <TabsContent value={selected}>
                <p className="my-2 break-all font-mono text-xs text-muted-foreground">
                  {current.path}
                </p>
                {current.target ? (
                  <p className="break-all text-sm">
                    Symlink → {current.target}. Edit its source file instead.
                  </p>
                ) : (
                  <div className="h-[min(55vh,36rem)]">
                    <TextEditor
                      key={current.path}
                      path={current.path}
                      label="Proxy configuration editor"
                      value={drafts[current.path] ?? current.content}
                      readOnly={!current.editable || busy}
                      onChange={(value) => {
                        setDraftRevisions((old) => ({
                          ...old,
                          [current.path]:
                            drafts[current.path] === undefined
                              ? current.revision
                              : (old[current.path] ?? current.revision),
                        }));
                        setDrafts((old) => ({ ...old, [current.path]: value }));
                      }}
                    />
                  </div>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    disabled={
                      busy ||
                      !current.editable ||
                      drafts[current.path] === undefined ||
                      (current.revision !== "missing" &&
                        drafts[current.path] === current.content)
                    }
                    onClick={() =>
                      onIntent({
                        operation: "save",
                        path: current.path,
                        content: drafts[current.path] ?? current.content,
                        revision:
                          draftRevisions[current.path] ?? current.revision,
                        treeRevision,
                      })
                    }
                  >
                    Review & apply
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || drafts[current.path] === undefined}
                    onClick={() => {
                      setDrafts((old) => {
                        const next = { ...old };
                        delete next[current.path];
                        return next;
                      });
                      setDraftRevisions((old) => {
                        const next = { ...old };
                        delete next[current.path];
                        return next;
                      });
                    }}
                  >
                    Discard changes
                  </Button>
                </div>
              </TabsContent>
            </Tabs>
          ) : (
            <p className="text-sm text-muted-foreground">
              No supported configuration files found.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

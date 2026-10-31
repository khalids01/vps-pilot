import { Channel, invoke } from "@tauri-apps/api/core";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
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
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { type ServerProfile, safeError } from "./api";
import { useCommandActivity } from "./command-activity";
import { filesApi } from "./files-api";
import { formatBytes } from "./structured-report";
import { TextEditor } from "./text-editor";
export type DockerSection =
  | "Containers"
  | "Deploy"
  | "Images"
  | "Volumes"
  | "Networks"
  | "Cleanup"
  | "Activity";
interface Resource {
  kind: "image" | "volume" | "network" | "container";
  id: string;
  name: string;
  bytes: number | null;
  references: string[];
  reason: string;
  eligible: boolean;
  fingerprint: string;
  driver?: string;
}
interface Snapshot {
  engine: { id: string; version: string };
  images: Resource[];
  volumes: Resource[];
  networks: Resource[];
  cleanup: Resource[];
  observedAt: number;
  buildCache: string;
}
interface Evidence {
  action: string;
  name: string;
  target: string;
  command: string;
  warning: string;
  blocked: string[];
  engine: { id: string; version: string };
  retainImages?: string[];
  services?: {
    name: string;
    image: string;
    imageId?: string;
    ports: string[];
    environment: string[];
  }[];
  targetPath?: string;
  directory?: string;
}
interface Review {
  token: string;
  serverName: string;
  evidence: Evidence;
  enabled: boolean;
}
interface Request {
  updateExisting?: boolean;
  action: string;
  target: string;
  kind?: string;
  content?: string;
  directory?: string;
}
const Context = createContext<{
  review: (r: Request) => void;
  busy: boolean;
  connected: boolean;
} | null>(null);
export function DockerLifecycle({ id, state }: { id: string; state: string }) {
  const manager = useContext(Context);
  if (!manager) return null;
  return (
    <div className="space-y-2 border-t pt-3">
      <div className="flex flex-wrap gap-2">
        {(["start", "stop", "restart"] as const).map((action) => (
          <Button
            key={action}
            variant="outline"
            size="sm"
            disabled={
              manager.busy ||
              !manager.connected ||
              (action === "start"
                ? !["exited", "created"].includes(state)
                : state !== "running")
            }
            onClick={() => manager.review({ action, target: id })}
          >
            Review {action}
          </Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Server, engine identity and dependencies are checked again before
        execution. Infrastructure workloads are protected.
      </p>
    </div>
  );
}
export function DockerManagement({
  profile,
  connected,
  tab,
  onTabChange,
  onChanged,
  children,
}: {
  profile: ServerProfile;
  connected: boolean;
  tab: DockerSection;
  onTabChange: (s: DockerSection) => void;
  onChanged: () => void;
  children: ReactNode;
}) {
  const activity = useCommandActivity();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [review, setReview] = useState<Review | null>(null),
    [confirm, setConfirm] = useState(""),
    [stage, setStage] = useState("");
  const [history, setHistory] = useState<
    {
      id: string;
      time: number;
      action: string;
      status: string;
      message: string;
      backup?: string;
      directory?: string;
      project?: string;
    }[]
  >([]);
  const [readFile, setReadFile] = useState<{
    path: string;
    directory?: string;
    project?: string;
  } | null>(null);
  const [form, setForm] = useState<
      "pull" | "createNetwork" | "createVolume" | null
    >(null),
    [name, setName] = useState("");
  const [project, setProject] = useState("my-app"),
    [directory, setDirectory] = useState("/srv/my-app"),
    [image, setImage] = useState("nginx:alpine"),
    [hostPort, setHostPort] = useState("8080"),
    [port, setPort] = useState("80"),
    [draft, setDraft] = useState(""),
    [advanced, setAdvanced] = useState(false);
  const [variables, setVariables] = useState<
    { id: string; key: string; value: string }[]
  >([]);
  const [search, setSearch] = useState("");
  const [updateExisting, setUpdateExisting] = useState(false);
  const mounted = useRef(true),
    inFlight = useRef(false),
    pending = useRef<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (pending.current)
        void invoke("ssh_docker_reject", {
          profileId: profile.id,
          token: pending.current,
        }).catch(() => {});
    };
  }, [profile.id]);
  const setYaml = (
    nextImage = image,
    nextHost = hostPort,
    nextPort = port,
    nextVars = variables,
  ) => {
    const environment = Object.fromEntries(
      nextVars.filter((v) => v.key).map((v) => [v.key, v.value]),
    );
    setDraft(
      JSON.stringify(
        {
          services: {
            app: {
              image: nextImage,
              ports: [`${nextHost}:${nextPort}`],
              environment,
              restart: "unless-stopped",
            },
          },
        },
        null,
        2,
      ),
    );
  };
  async function scan() {
    if (inFlight.current || !connected) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    const entry = activity.begin(
      "Docker resource inventory",
      "Read Docker engine/container/image/network/volume metadata",
    );
    try {
      const result = await invoke<{ snapshot: Snapshot }>(
        "ssh_docker_snapshot",
        { profileId: profile.id },
      );
      if (mounted.current) {
        setSnapshot(result.snapshot);
        activity.update(entry, { status: "completed", ended: Date.now() });
      }
    } catch (e) {
      if (mounted.current) {
        setError(safeError(e));
        activity.update(entry, {
          status: "failed",
          message: safeError(e),
          ended: Date.now(),
        });
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function prepare(request: Request) {
    if (inFlight.current || !connected) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setConfirm("");
    const entry = activity.begin(
      `Review Docker ${request.action}`,
      "Read current Docker engine identity and dependencies",
    );
    try {
      const result = await invoke<Review>("ssh_docker_review", {
        profileId: profile.id,
        request: JSON.stringify(request),
      });
      if (mounted.current) {
        pending.current = result.token;
        setReview(result);
        activity.update(entry, {
          command: result.evidence.command,
          status: "completed",
          ended: Date.now(),
        });
      } else
        void invoke("ssh_docker_reject", {
          profileId: profile.id,
          token: result.token,
        }).catch(() => {});
    } catch (e) {
      if (mounted.current) {
        setError(safeError(e));
        activity.update(entry, {
          status: "failed",
          message: safeError(e),
          ended: Date.now(),
        });
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function reject() {
    if (busy) return;
    const token = pending.current;
    pending.current = null;
    setReview(null);
    setConfirm("");
    if (token)
      void invoke("ssh_docker_reject", { profileId: profile.id, token }).catch(
        () => {},
      );
  }
  async function execute() {
    if (!review || inFlight.current) return;
    const plan = review;
    pending.current = null;
    setReview(null);
    inFlight.current = true;
    setBusy(true);
    setError("");
    setStage("Rechecking Docker state…");
    const entry = activity.begin(
      `Docker ${plan.evidence.action}`,
      plan.evidence.command,
    );
    const progress = new Channel<{ stage: string; message: string }>();
    progress.onmessage = (value) => {
      if (mounted.current) setStage(value.message);
    };
    try {
      const result = await invoke<{
        status: string;
        message: string;
        backup: string | null;
        snapshot?: Snapshot;
      }>("ssh_docker_execute", {
        profileId: profile.id,
        token: plan.token,
        progress,
      });
      if (mounted.current) {
        if (result.snapshot) setSnapshot(result.snapshot);
        if (result.status === "completed") onChanged();
        setHistory((old) =>
          [
            {
              id: crypto.randomUUID(),
              time: Date.now(),
              action: plan.evidence.action,
              status: result.status,
              message: result.message,
              backup: result.backup ?? undefined,
              directory: plan.evidence.directory,
              project:
                plan.evidence.action === "deploy"
                  ? plan.evidence.target
                  : undefined,
            },
            ...old,
          ].slice(0, 20),
        );
        activity.update(entry, {
          status: result.status === "completed" ? "completed" : "failed",
          message: result.message,
          ended: Date.now(),
        });
        setStage(result.message);
      }
    } catch (e) {
      if (mounted.current) {
        setError(safeError(e));
        setHistory((old) =>
          [
            {
              id: crypto.randomUUID(),
              time: Date.now(),
              action: plan.evidence.action,
              status: "uncertain",
              message: safeError(e),
            },
            ...old,
          ].slice(0, 20),
        );
        activity.update(entry, {
          status: "failed",
          message: safeError(e),
          ended: Date.now(),
        });
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function loadConfiguration() {
    if (!readFile || inFlight.current) return;
    const item = readFile;
    setReadFile(null);
    inFlight.current = true;
    setBusy(true);
    setError("");
    const entry = activity.begin(
      "Load Compose configuration",
      `SFTP · ${item.path}`,
    );
    try {
      const file = await filesApi.read(profile.id, item.path);
      if (mounted.current) {
        setDraft(file.content);
        setAdvanced(true);
        if (item.directory) setDirectory(item.directory);
        if (item.project) setProject(item.project);
        onTabChange("Deploy");
        activity.update(entry, { status: "completed", ended: Date.now() });
      }
    } catch (e) {
      if (mounted.current) {
        setError(safeError(e));
        activity.update(entry, {
          status: "failed",
          message: safeError(e),
          ended: Date.now(),
        });
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const list =
    tab === "Images"
      ? snapshot?.images
      : tab === "Volumes"
        ? snapshot?.volumes
        : tab === "Networks"
          ? snapshot?.networks
          : snapshot?.cleanup;
  const matches = (list ?? []).filter((r) =>
    `${r.name} ${r.id}`.toLowerCase().includes(search.toLowerCase()),
  );
  const reviewRemove = (r: Resource) =>
    void prepare({ action: "cleanup", target: r.id, kind: r.kind });
  return (
    <Context.Provider
      value={{ review: (r) => void prepare(r), busy, connected }}
    >
      <div className="space-y-6">
        <nav
          aria-label="Docker sections"
          className="flex gap-2 overflow-x-auto border-b pb-3"
        >
          {(
            [
              "Containers",
              "Deploy",
              "Images",
              "Volumes",
              "Networks",
              "Cleanup",
              "Activity",
            ] as DockerSection[]
          ).map((section) => (
            <Button
              key={section}
              variant={tab === section ? "secondary" : "ghost"}
              size="sm"
              aria-current={tab === section ? "page" : undefined}
              onClick={() => {
                onTabChange(section);
                setSearch("");
              }}
            >
              {section === "Deploy" ? "Run application" : section}
            </Button>
          ))}
        </nav>
        {error && (
          <p role="alert" className="break-all text-sm text-destructive">
            {error}
          </p>
        )}
        {busy && (
          <p role="status" className="text-sm text-muted-foreground">
            {stage || "Checking Docker evidence…"} Execution may continue
            remotely if the connection is interrupted; inspect before retrying.
          </p>
        )}
        {!busy && stage && (
          <p role="status" className="text-xs text-muted-foreground">
            {stage}
          </p>
        )}
        <div className={tab === "Containers" ? "block" : "hidden"}>
          {children}
        </div>
        {(
          ["Images", "Volumes", "Networks", "Cleanup"] as DockerSection[]
        ).includes(tab) && (
          <section
            aria-label={`Docker ${tab.toLowerCase()}`}
            className="space-y-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="font-semibold">{tab}</h3>
                <p className="text-xs text-muted-foreground">
                  {snapshot
                    ? `Snapshot ${new Date(snapshot.observedAt * 1000).toLocaleString()}`
                    : "No resources scanned yet. Nothing runs automatically."}
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  disabled={busy || !connected}
                  onClick={() => void scan()}
                >
                  {tab === "Cleanup"
                    ? "Scan cleanup candidates"
                    : "Load resources"}
                </Button>
                {tab !== "Cleanup" && (
                  <Button
                    disabled={busy || !connected}
                    onClick={() => {
                      setName("");
                      setForm(
                        tab === "Images"
                          ? "pull"
                          : tab === "Volumes"
                            ? "createVolume"
                            : "createNetwork",
                      );
                    }}
                  >
                    {tab === "Images"
                      ? "Pull image"
                      : tab === "Volumes"
                        ? "Create volume"
                        : "Create network"}
                  </Button>
                )}
              </div>
            </div>
            {tab === "Cleanup" && (
              <p className="rounded-lg border p-3 text-sm">
                Only unreferenced, untagged images, unused non-Compose bridge
                networks and unmounted standalone stopped containers older than
                seven days qualify. All volumes and bind-mounted data are
                protected. No force removal or system prune.
              </p>
            )}
            {snapshot && (
              <>
                <Input
                  aria-label="Search Docker resources"
                  placeholder="Search resources…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <div className="overflow-x-auto rounded-xl border">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr>
                        {[
                          "Resource",
                          "Size",
                          "References / protection",
                          "Actions",
                        ].map((label) => (
                          <th key={label} className="p-3">
                            {label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {matches.map((r) => (
                        <tr key={`${r.kind}:${r.id}`} className="border-t">
                          <td className="max-w-72 break-all p-3">
                            {r.name}
                            <p className="text-muted-foreground">
                              {r.kind}
                              {r.driver ? ` · ${r.driver}` : ""}
                            </p>
                          </td>
                          <td className="p-3">
                            {r.bytes === null
                              ? "Unknown"
                              : formatBytes(r.bytes)}
                          </td>
                          <td className="max-w-80 break-all p-3">
                            {r.reason || "Eligible for reviewed cleanup"}
                            {r.references.length > 0 && (
                              <p>{r.references.join(", ")}</p>
                            )}
                          </td>
                          <td className="p-3">
                            <Menu>
                              <MenuTrigger
                                aria-label={`Actions for ${r.name}`}
                                render={<Button variant="ghost" size="sm" />}
                              >
                                ⋯
                              </MenuTrigger>
                              <MenuContent>
                                <MenuItem
                                  disabled={busy || !connected || !r.eligible}
                                  onClick={() => reviewRemove(r)}
                                >
                                  Review removal
                                </MenuItem>
                              </MenuContent>
                            </Menu>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!matches.length && (
                    <p className="p-4">No resources match this view.</p>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Image sizes include shared layers and are not guaranteed freed
                  space. {snapshot.buildCache}
                </p>
              </>
            )}
          </section>
        )}
        {tab === "Deploy" && (
          <section
            aria-label="Compose deployment"
            className="max-w-3xl space-y-8 rounded-xl border bg-card/30 p-5 sm:p-7"
          >
            <div className="space-y-2">
              <h3 className="text-lg font-semibold">Run an application</h3>
              <p className="text-sm text-muted-foreground">
                Choose an image and where to keep its configuration. Review
                safety checks before anything runs.
              </p>
            </div>
            <fieldset className="space-y-4">
              <legend className="mb-4 text-sm font-medium">Application</legend>
              <div className="grid gap-5 sm:grid-cols-2">
                <label
                  className="block space-y-2 text-sm"
                  htmlFor={`docker-project-${profile.id}`}
                >
                  Application name
                  <Input
                    id={`docker-project-${profile.id}`}
                    aria-label="Compose project name"
                    value={project}
                    onChange={(e) => setProject(e.target.value)}
                  />
                </label>
                <label
                  className="block space-y-2 text-sm"
                  htmlFor={`docker-directory-${profile.id}`}
                >
                  Remote application folder
                  <Input
                    id={`docker-directory-${profile.id}`}
                    aria-label="Compose application folder"
                    value={directory}
                    onChange={(e) => setDirectory(e.target.value)}
                  />
                  <span className="block text-xs text-muted-foreground">
                    Choose an existing folder, or create one in Files.
                  </span>
                </label>
              </div>
              <label
                className="flex items-center gap-3 text-sm"
                htmlFor={`docker-update-${profile.id}`}
              >
                <Checkbox
                  id={`docker-update-${profile.id}`}
                  checked={updateExisting}
                  onCheckedChange={(checked) =>
                    setUpdateExisting(checked === true)
                  }
                />
                Update an existing application with this name and folder
              </label>
            </fieldset>
            <div className="flex gap-2">
              <Button
                variant={advanced ? "outline" : "secondary"}
                size="sm"
                onClick={() => {
                  setAdvanced(false);
                }}
              >
                Image and settings
              </Button>
              <Button
                variant={advanced ? "secondary" : "outline"}
                size="sm"
                onClick={() => {
                  if (!draft) setYaml();
                  setAdvanced(true);
                }}
              >
                Use Compose file
              </Button>
            </div>
            {!advanced ? (
              <div className="space-y-7">
                <fieldset className="space-y-3">
                  <legend className="mb-3 text-sm font-medium">Image</legend>
                  <label
                    className="block space-y-2 text-sm"
                    htmlFor={`docker-image-${profile.id}`}
                  >
                    Image
                    <Input
                      id={`docker-image-${profile.id}`}
                      aria-label="Deployment image"
                      value={image}
                      onChange={(e) => {
                        setImage(e.target.value);
                        setYaml(e.target.value);
                      }}
                    />
                  </label>
                  <p className="text-xs text-muted-foreground">
                    Use an image already on this server. Pull missing images
                    from the Images tab.
                  </p>
                </fieldset>
                <fieldset className="space-y-4">
                  <legend className="mb-3 text-sm font-medium">Ports</legend>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label
                      className="block space-y-2 text-sm"
                      htmlFor={`docker-host-port-${profile.id}`}
                    >
                      Server port
                      <Input
                        id={`docker-host-port-${profile.id}`}
                        aria-label="Published port"
                        value={hostPort}
                        onChange={(e) => {
                          setHostPort(e.target.value);
                          setYaml(image, e.target.value);
                        }}
                      />
                    </label>
                    <label
                      className="block space-y-2 text-sm"
                      htmlFor={`docker-port-${profile.id}`}
                    >
                      Container port
                      <Input
                        id={`docker-port-${profile.id}`}
                        aria-label="Container port"
                        value={port}
                        onChange={(e) => {
                          setPort(e.target.value);
                          setYaml(image, hostPort, e.target.value);
                        }}
                      />
                    </label>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Server port receives traffic; container port is where the
                    application listens. Occupied ports are blocked.
                  </p>
                </fieldset>
                <fieldset className="space-y-4">
                  <legend className="mb-3 text-sm font-medium">
                    Environment variables{" "}
                    <span className="font-normal text-muted-foreground">
                      · optional
                    </span>
                  </legend>
                  {variables.length > 0 && (
                    <div className="grid grid-cols-2 gap-3 text-xs text-muted-foreground">
                      <span>Name</span>
                      <span>Value</span>
                    </div>
                  )}
                  {variables.map((v, index) => (
                    <div key={v.id} className="grid grid-cols-2 gap-3">
                      <Input
                        aria-label={`Environment name ${index + 1}`}
                        value={v.key}
                        onChange={(e) => {
                          const next = variables.map((item, i) =>
                            i === index
                              ? { ...item, key: e.target.value }
                              : item,
                          );
                          setVariables(next);
                          setYaml(image, hostPort, port, next);
                        }}
                      />
                      <Input
                        type="password"
                        autoComplete="off"
                        aria-label={`Environment value ${index + 1}`}
                        value={v.value}
                        onChange={(e) => {
                          const next = variables.map((item, i) =>
                            i === index
                              ? { ...item, value: e.target.value }
                              : item,
                          );
                          setVariables(next);
                          setYaml(image, hostPort, port, next);
                        }}
                      />
                    </div>
                  ))}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setVariables((old) => [
                        ...old,
                        { id: crypto.randomUUID(), key: "", value: "" },
                      ])
                    }
                  >
                    Add environment variable
                  </Button>
                </fieldset>
              </div>
            ) : (
              <div className="space-y-4">
                <Button
                  variant="outline"
                  disabled={busy || !connected}
                  onClick={() =>
                    setReadFile({
                      path: `${directory.replace(/\/$/, "")}/compose.yaml`,
                    })
                  }
                >
                  Load existing Compose file
                </Button>
                <TextEditor
                  value={draft}
                  onChange={setDraft}
                  path="compose.yaml"
                  label="Compose YAML editor"
                />
              </div>
            )}
            <div className="space-y-3 border-t pt-6">
              <Button
                disabled={
                  busy ||
                  !connected ||
                  !project.trim() ||
                  !directory.trim() ||
                  (!advanced && (!image.trim() || !hostPort || !port))
                }
                onClick={() => {
                  const content = advanced
                    ? draft
                    : JSON.stringify({
                        services: {
                          app: {
                            image,
                            ports: [`${hostPort}:${port}`],
                            environment: Object.fromEntries(
                              variables
                                .filter((v) => v.key)
                                .map((v) => [v.key, v.value]),
                            ),
                            restart: "unless-stopped",
                          },
                        },
                      });
                  void prepare({
                    action: "deploy",
                    target: project,
                    directory,
                    content,
                    updateExisting,
                  });
                }}
              >
                Review application
              </Button>
              <p className="text-xs text-muted-foreground">
                Checks ports, existing applications and host access. Existing
                configuration is backed up before an approved update.
              </p>
            </div>
          </section>
        )}
        {tab === "Activity" && (
          <section aria-label="Docker operation history" className="space-y-3">
            <h3 className="font-semibold">Operations on {profile.name}</h3>
            {!history.length && (
              <p className="text-sm text-muted-foreground">
                No management operations in this open workspace. History is
                memory-only.
              </p>
            )}
            {history.map((h) => (
              <article
                key={h.id}
                className="space-y-1 rounded-lg border p-3 text-sm"
              >
                <p>
                  {h.action} · {h.status} · {new Date(h.time).toLocaleString()}
                </p>
                <p>{h.message}</p>
                {h.backup && (
                  <p className="break-all text-xs">
                    Private configuration backup: {h.backup}
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2"
                      disabled={busy || !connected}
                      onClick={() =>
                        setReadFile({
                          path: h.backup as string,
                          directory: h.directory,
                          project: h.project,
                        })
                      }
                    >
                      Review previous configuration
                    </Button>
                  </p>
                )}
              </article>
            ))}
          </section>
        )}
      </div>
      <Dialog
        open={!!readFile}
        onOpenChange={(open) => {
          if (!open) setReadFile(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Load Compose configuration?</DialogTitle>
            <DialogDescription>
              This replaces the in-memory editor contents. The file may contain
              credentials; its contents will not enter local persistence or
              command history.
            </DialogDescription>
          </DialogHeader>
          <p className="break-all text-xs">{readFile?.path}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReadFile(null)}>
              Cancel
            </Button>
            <Button
              disabled={busy || !connected}
              onClick={() => void loadConfiguration()}
            >
              Load into editor
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!form}
        onOpenChange={(open) => {
          if (!open) setForm(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {form === "pull"
                ? "Pull an image"
                : form === "createVolume"
                  ? "Create a volume"
                  : "Create a bridge network"}
            </DialogTitle>
            <DialogDescription>
              {profile.name} · Existing resources are never overwritten. Image
              pulls use this SSH user's configured registry access.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-6 pt-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (form) {
                void prepare({ action: form, target: name });
                setForm(null);
              }
            }}
          >
            <label
              className="block space-y-2 text-sm"
              htmlFor="docker-resource-name"
            >
              {form === "pull" ? "Image reference" : "Name"}
              <Input
                id="docker-resource-name"
                placeholder={form === "pull" ? "nginx:alpine" : "my-app-data"}
                aria-label="Docker resource name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setForm(null)}
              >
                Cancel
              </Button>
              <Button disabled={!name || busy}>Review request</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!review}
        onOpenChange={(open) => {
          if (!open) reject();
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Review Docker operation</DialogTitle>
            <DialogDescription>
              {review?.serverName} · {review?.evidence.action} ·{" "}
              {review?.evidence.name}
            </DialogDescription>
          </DialogHeader>
          {review?.evidence.action === "deploy" &&
            !review.evidence.blocked?.length && (
              <p className="rounded-lg border bg-muted/30 p-3 text-sm">
                Preflight passed: port availability, application identity and
                host access restrictions checked. These checks run again before
                execution.
              </p>
            )}
          <p className="break-all text-xs">
            Engine: {review?.evidence.engine.id}
          </p>
          <pre className="whitespace-pre-wrap break-all rounded-lg border p-3 text-xs">
            {review?.evidence.command}
          </pre>
          {review?.evidence.services?.map((s) => (
            <div key={s.name} className="rounded-lg border p-3 text-xs">
              <p>
                {s.name} · {s.image}
              </p>
              {s.imageId && (
                <p className="break-all">Resolved image: {s.imageId}</p>
              )}
              <p>Published ports: {s.ports.join(", ") || "none"}</p>
              <p>
                Environment keys: {s.environment.join(", ") || "none"} · values
                hidden
              </p>
            </div>
          ))}
          {!!review?.evidence.blocked?.length && (
            <ul className="list-inside list-disc text-sm text-destructive">
              {review.evidence.blocked.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">
            {review?.evidence.warning}{" "}
            {review?.evidence.retainImages?.length
              ? "Previous image IDs are retained from cleanup for future recovery."
              : ""}{" "}
            Reviews expire in two minutes. Execution cannot be undone by
            cancelling the connection.
          </p>
          {!review?.enabled && (
            <p className="text-sm text-muted-foreground">
              Execution awaits disposable-VM validation; this preview makes no
              changes.
            </p>
          )}
          {review?.evidence.action === "cleanup" && (
            <label
              className="block space-y-2 text-sm"
              htmlFor={`docker-cleanup-${profile.id}`}
            >
              Type the exact resource name to confirm irreversible removal
              <Input
                id={`docker-cleanup-${profile.id}`}
                aria-label="Confirm cleanup resource name"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </label>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={reject}>
              Cancel
            </Button>
            <Button
              disabled={
                busy ||
                !connected ||
                !review?.enabled ||
                !!review.evidence.blocked?.length ||
                (review.evidence.action === "cleanup" &&
                  confirm !== review.evidence.name)
              }
              onClick={() => void execute()}
            >
              {review?.evidence.action === "deploy"
                ? "Run application"
                : "Confirm operation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Context.Provider>
  );
}

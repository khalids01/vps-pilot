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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { type ServerProfile, safeError } from "./api";
import { useCommandActivity } from "./command-activity";
import { useConfiguration } from "./configuration-context";
import { quickSetupCatalogLabel } from "./quick-setup-catalog";
import { stepItems } from "./quick-setup-execution-model";
import type { QuickSetupDraft } from "./quick-setup-model";

export const setupPackageIds = [
  "git",
  "curl",
  "ripgrep",
  "fd",
  "fzf",
  "jq",
  "btop",
  "unzip",
  "tmux",
  "bat",
  "eza",
  "rsync",
  "direnv",
  "python",
  "podman",
  "docker",
  "neovim",
  "bun",
  "uv",
  "go",
  "herdr",
  "nvm-node",
  "javascript-pm2",
  "dokploy",
  "lazyvim-starter",
];
export interface SetupPackageItem {
  id: string;
  status:
    | "installed"
    | "missing"
    | "unknown"
    | "conflict"
    | "failed"
    | "installing";
  message: string;
  version?: string;
  source?: string;
  artifacts?: { url: string; sha256: string }[];
  images?: Record<string, string>;
}
interface Approval {
  reviewId: string;
  command: string;
  purpose: string;
  items?: SetupPackageItem[];
}
interface PackageContext {
  items: SetupPackageItem[];
  busy: boolean;
  error: string;
  scan: () => Promise<void>;
  prepare: (ids: string[]) => Promise<void>;
}
const Context = createContext<PackageContext | null>(null);
export function useSetupPackages() {
  const context = useContext(Context);
  if (!context) throw Error("Setup packages require a workspace.");
  return context;
}

// Observations stay in this workspace's memory across steps. A new connection
// mounts a fresh provider; persisted choices never restore installation evidence.
export function QuickSetupPackageProvider({
  profile,
  visible,
  children,
}: {
  profile: ServerProfile;
  visible: boolean;
  children: ReactNode;
}) {
  const { connectionId } = useConfiguration();
  const log = useCommandActivity();
  const [items, setItems] = useState<SetupPackageItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [approval, setApproval] = useState<Approval | null>(null);
  const [password, setPassword] = useState("");
  const [reviewedIds, setReviewedIds] = useState<string[]>([]);
  const running = useRef(false);
  const alive = useRef(true);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!visible) {
      setPassword("");
      setApproval(null);
    }
  }, [visible]);
  function source(ids: string[]) {
    return {
      profileId: profile.id,
      profileRevision: profile.revision,
      connectionId,
      items: ids,
    };
  }
  function merge(rows: SetupPackageItem[]) {
    if (alive.current)
      setItems((old) => [
        ...old.filter((row) => !rows.some((item) => item.id === row.id)),
        ...rows,
      ]);
  }
  async function scan() {
    if (running.current || !connectionId) return;
    running.current = true;
    setBusy(true);
    setError("");
    let activity: string | undefined;
    try {
      const command = await invoke<string>("ssh_setup_packages_command");
      activity = log.begin("Check installed tools", command);
      const result = await invoke<{ items: SetupPackageItem[] }>(
        "ssh_setup_packages_scan",
        { source: source(setupPackageIds) },
      );
      merge(result.items);
      log.update(activity, {
        status: "completed",
        ended: Date.now(),
        message: "Tool status checked.",
        code: 0,
      });
    } catch (failure) {
      if (activity)
        log.update(activity, {
          status: "failed",
          ended: Date.now(),
          message: safeError(failure),
          code: null,
        });
      if (alive.current) setError(safeError(failure));
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function prepare(ids: string[]) {
    if (running.current || !connectionId || !ids.length) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await invoke<Approval>("ssh_setup_packages_prepare", {
        source: source(ids),
      });
      if (alive.current && visibleRef.current) {
        setReviewedIds(ids);
        setApproval(result);
      }
    } catch (failure) {
      if (alive.current) setError(safeError(failure));
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function apply() {
    if (!approval || running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    const reviewId = approval.reviewId;
    const activity = log.begin("Install selected tools", approval.command);
    const sudoPassword = password;
    const ids = reviewedIds;
    setApproval(null);
    setPassword("");
    const confirmed = new Set<string>();
    const progress = new Channel<SetupPackageItem>();
    progress.onmessage = (row) => {
      if (ids.includes(row.id)) {
        if (row.status === "installed") confirmed.add(row.id);
        merge([row]);
      }
    };
    try {
      const result = await invoke<{
        items: SetupPackageItem[];
        dependencies?: SetupPackageItem[];
      }>("ssh_setup_packages_apply", {
        reviewId,
        sudoPassword,
        onProgress: progress,
      });
      merge([...result.items, ...(result.dependencies ?? [])]);
      const incomplete = result.items.some(
        (item) => item.status !== "installed",
      );
      log.update(activity, {
        status: incomplete ? "failed" : "completed",
        ended: Date.now(),
        message: incomplete
          ? "Some selected items need attention."
          : "Selected tools installed.",
        code: incomplete ? null : 0,
      });
    } catch (failure) {
      // A disconnected batch may have completed work. Never call that failure
      // proof of absence, or automatically repeat a possibly completed install.
      merge(
        ids
          .filter((id) => !confirmed.has(id))
          .map((id) => ({
            id,
            status: "unknown",
            message: "Check installed before retrying.",
          })),
      );
      log.update(activity, {
        status: "failed",
        ended: Date.now(),
        message: safeError(failure),
        code: null,
      });
      if (alive.current) setError(safeError(failure));
    } finally {
      progress.onmessage = () => {};
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <Context.Provider value={{ items, busy, error, scan, prepare }}>
      {children}
      <Dialog
        open={Boolean(approval)}
        onOpenChange={(open) => {
          if (!open) {
            setApproval(null);
            setPassword("");
          }
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] min-w-0 overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Install selected packages</DialogTitle>
            <DialogDescription>
              {profile.username}@{profile.host}:{profile.port}
            </DialogDescription>
          </DialogHeader>
          <ul className="divide-y text-sm">
            {(
              approval?.items ??
              reviewedIds.map(
                (id) =>
                  ({ id, status: "missing", message: "" }) as SetupPackageItem,
              )
            ).map((item) => (
              <li key={item.id} className="py-2">
                <p className="break-words [overflow-wrap:anywhere]">
                  {quickSetupCatalogLabel(item.id)}
                  {item.version ? ` · ${item.version}` : ""}
                </p>
                {item.source && (
                  <p className="mt-1 break-all text-xs text-muted-foreground">
                    {item.source}
                  </p>
                )}
                {item.message && (
                  <p className="mt-1 text-xs text-warning">{item.message}</p>
                )}
                {(item.artifacts?.length || item.images) && (
                  <details className="mt-2 text-xs text-muted-foreground">
                    <summary className="cursor-pointer">
                      Artifact identities
                    </summary>
                    <ul className="space-y-2 pt-2">
                      {item.artifacts?.map((artifact) => (
                        <li key={artifact.url} className="break-all">
                          {artifact.url}
                          <br />
                          SHA-256: {artifact.sha256}
                        </li>
                      ))}
                      {Object.entries(item.images ?? {}).map(
                        ([name, image]) => (
                          <li key={name} className="break-all">
                            {name}: {image}
                          </li>
                        ),
                      )}
                    </ul>
                  </details>
                )}
              </li>
            ))}
          </ul>
          {profile.username !== "root" && (
            <div className="space-y-2">
              <label
                htmlFor="setup-packages-password"
                className="block text-sm"
              >
                Sudo password
              </label>
              <Input
                id="setup-packages-password"
                type="password"
                autoComplete="new-password"
                value={password}
                maxLength={4096}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          )}
          <details className="min-w-0 text-xs">
            <summary className="cursor-pointer">Command and sources</summary>
            <pre className="mt-2 max-h-40 max-w-full overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">
              {approval?.command}
            </pre>
          </details>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setApproval(null);
                setPassword("");
              }}
            >
              Cancel
            </Button>
            <Button onClick={() => void apply()}>Apply</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Context.Provider>
  );
}

export function QuickSetupPackageStatus({
  id,
  dependencies = [],
}: {
  id: string;
  dependencies?: string[];
}) {
  const { items } = useSetupPackages();
  const expected = [id, ...dependencies].map(
    (key) =>
      items.find((row) => row.id === key) ?? {
        id: key,
        status: "unknown" as const,
        message: "",
      },
  );
  const main = expected[0];
  const priority = [
    "failed",
    "installing",
    "conflict",
    "unknown",
    "missing",
    "installed",
  ];
  const observed = expected.reduce(
    (worst, row) =>
      priority.indexOf(row.status) < priority.indexOf(worst.status)
        ? row
        : worst,
    main,
  );
  const item = {
    ...observed,
    version: observed.status === "installed" ? main?.version : observed.version,
    message:
      observed.message && observed.id !== id
        ? `${quickSetupCatalogLabel(observed.id)}: ${observed.message}`
        : observed.message,
  };
  const label =
    item?.status === "installed"
      ? "Installed"
      : item?.status === "missing"
        ? "Not installed"
        : item?.status === "conflict"
          ? "Conflict"
          : item?.status === "failed"
            ? "Failed"
            : item?.status === "installing"
              ? "Installing…"
              : "Unknown";
  return (
    <span
      aria-live="polite"
      className={`block text-xs [overflow-wrap:anywhere] ${item?.status === "installed" ? "text-primary" : item?.status === "failed" || item?.status === "conflict" ? "text-destructive" : "text-muted-foreground"}`}
    >
      {label}
      {item?.version
        ? ` · ${id === "lazyvim-starter" ? item.version.slice(0, 12) : item.version}`
        : ""}
      {item?.message && <span className="mt-0.5 block">{item.message}</span>}
    </span>
  );
}

export function QuickSetupPackages({
  profile: _profile,
  draft,
  visible: _visible,
}: {
  profile: ServerProfile;
  draft: QuickSetupDraft;
  visible: boolean;
}) {
  const { connectionId } = useConfiguration();
  const { items, busy, error, scan, prepare } = useSetupPackages();
  const selected = stepItems(draft);
  const failed = selected.filter(
    (item) => items.find((row) => row.id === item.id)?.status === "failed",
  );
  const pending = selected.filter(
    (item) => items.find((row) => row.id === item.id)?.status !== "installed",
  );
  const conflicts = pending.some(
    (item) => items.find((row) => row.id === item.id)?.status === "conflict",
  );
  return (
    <section
      aria-label="Install selected tools"
      className="space-y-3 border-t pt-4"
    >
      {error && (
        <p
          role="alert"
          className="text-sm text-destructive [overflow-wrap:anywhere]"
        >
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={busy || !connectionId}
          onClick={() => void scan()}
        >
          {busy ? "Working…" : "Check installed"}
        </Button>
        <Button
          disabled={busy || !connectionId || !pending.length || conflicts}
          onClick={() =>
            void prepare(
              (failed.length ? failed : pending).map((item) => item.id),
            )
          }
        >
          {failed.length ? "Retry failed" : "Install selected"}
        </Button>
      </div>
    </section>
  );
}

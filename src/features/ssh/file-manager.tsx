/** biome-ignore-all lint/a11y/useSemanticElements: This WAI-ARIA grid shares its DOM and keyboard model between list and icon layouts. */
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Calculator,
  ClipboardPaste,
  Copy,
  Download,
  File,
  Folder,
  FolderPlus,
  Grid2X2,
  Info,
  List,
  LockKeyhole,
  MoreHorizontal,
  MoveRight,
  Pencil,
  RefreshCw,
  Scissors,
  Search,
  Trash2,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
} from "@/components/ui/menu";
import type { ServerProfile } from "./api";
import {
  type Box,
  clickSelection,
  intersect,
  rectangle,
} from "./file-selection";
import {
  type FileOperation,
  type FileRunner,
  type FolderSize,
  filesApi,
  managerApi,
  type OperationInput,
  type OperationProgress,
  type OperationResult,
  type OperationReview,
  type RemoteDirectory,
  type RemoteEntry,
} from "./files-api";
import { formatBytes } from "./structured-report";

const labels: Record<FileOperation, string> = {
  copy: "Copy",
  move: "Move",
  trash: "Delete to trash",
  restore: "Restore",
  mkdir: "Create folder",
  download: "Download ZIP",
};
const protectedPath = (path: string) =>
  path === "/" ||
  [
    "/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/boot",
    "/proc",
    "/sys",
    "/dev",
    "/run",
    "/var/lib",
    "/var/log",
  ].some(
    (root) =>
      path === root ||
      path.startsWith(`${root}/`) ||
      root.startsWith(`${path}/`),
  ) ||
  ["/home", "/root", "/srv", "/opt", "/tmp", "/mnt", "/media"].includes(path) ||
  /^\/home\/[^/]+$/.test(path) ||
  path
    .split("/")
    .some(
      (part) =>
        [
          ".ssh",
          ".gnupg",
          ".aws",
          ".kube",
          ".docker",
          "pgdata",
          "postgresql",
          "mysql",
          "mariadb",
          "mongodb",
          "redis",
          "docker",
          "containers",
          "volumes",
        ].includes(part) || /^\.vps-pilot-(backup|transfer|trash)-/.test(part),
    );
const mode = (value: number | null) =>
  value === null ? "—" : (value & 0o777).toString(8).padStart(3, "0");
interface Props {
  profile: ServerProfile;
  connected: boolean;
  busy: boolean;
  run: FileRunner;
  onOpen: (path: string) => void;
  onUpload: (directory: string) => void;
  editor: ReactNode;
  refreshKey: number;
  beforeMutation: (paths: string[], action: () => void) => void;
  onCompleted: (operation: FileOperation, result: OperationResult) => void;
}
export function FileManager({
  profile,
  connected,
  busy,
  run,
  onOpen,
  onUpload,
  editor,
  refreshKey,
  beforeMutation,
  onCompleted,
}: Props) {
  const [details, setDetails] = useState<RemoteEntry | null>(null);
  const [editPath, setEditPath] = useState(false);
  const [contextEmpty, setContextEmpty] = useState(true);
  const [directory, setDirectory] = useState<RemoteDirectory | null>(null);
  const [location, setLocation] = useState("/");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [query, setQuery] = useState("");
  const [hidden, setHidden] = useState(true);
  const [view, setView] = useState<"list" | "grid">("list");
  const [sort, setSort] = useState<"name" | "size" | "modified">("name");
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<{
    paths: string[];
    kind: "copy" | "move";
  } | null>(null);
  const [review, setReview] = useState<OperationReview | null>(null);
  const [progress, setProgress] = useState<OperationProgress | null>(null);
  const [result, setResult] = useState<OperationResult | null>(null);
  const [notice, setNotice] = useState("");
  const cancelRequested = useRef(false);
  const [cancelling, setCancelling] = useState(false);
  const [dialog, setDialog] = useState<"move" | "rename" | "mkdir" | null>(
    null,
  );
  const [dialogValue, setDialogValue] = useState("");
  const [sizes, setSizes] = useState<Record<string, FolderSize>>({});
  const [box, setBox] = useState<Box | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const loaded = useRef(false);
  const mounted = useRef(true);
  const reviewRef = useRef(review);
  reviewRef.current = review;
  const skipClick = useRef(false);
  const drag = useRef<{
    start: { x: number; y: number };
    base: string[];
    items: { path: string; box: Box }[];
    active: boolean;
  } | null>(null);
  const idsRef = useRef<string[]>([]);
  const appliedRefresh = useRef(refreshKey);
  const entries = [...(directory?.entries ?? [])]
    .filter(
      (entry) =>
        (hidden || !entry.name.startsWith(".")) &&
        entry.name.toLowerCase().includes(query.toLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(b.kind === "directory") - Number(a.kind === "directory") ||
        (sort === "size"
          ? (b.kind === "directory"
              ? (sizes[b.path]?.bytes ?? -1)
              : (b.size ?? -1)) -
            (a.kind === "directory"
              ? (sizes[a.path]?.bytes ?? -1)
              : (a.size ?? -1))
          : sort === "modified"
            ? (b.modified ?? 0) - (a.modified ?? 0)
            : a.name.localeCompare(b.name, undefined, { numeric: true })) ||
        a.path.localeCompare(b.path),
    );
  const selectedEntries = (directory?.entries ?? []).filter((entry) =>
    selected.includes(entry.path),
  );
  const protectedSelection = selectedEntries.some(
    (entry) => entry.protected ?? protectedPath(entry.path),
  );
  idsRef.current = entries.map((entry) => entry.path);
  const load = (
    path: string,
    historyMode: "push" | "replace" = "push",
    index?: number,
  ) =>
    void run(
      "Load remote folder",
      () => filesApi.list(profile.id, path),
      (data) => {
        setDirectory(data);
        setDetails(null);
        setEditPath(false);
        setLocation(data.path);
        setQuery("");
        setSelected([]);
        setAnchor(null);
        setSizes({});
        if (index !== undefined) setHistoryIndex(index);
        else if (
          historyMode === "push" &&
          history[historyIndex] !== data.path
        ) {
          setHistory((old) => [...old.slice(0, historyIndex + 1), data.path]);
          setHistoryIndex(historyIndex + 1);
        }
      },
    );
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (connected && !loaded.current) {
      loaded.current = true;
      loadRef.current("/");
    }
  }, [connected]);
  useEffect(() => {
    if (
      !busy &&
      connected &&
      directory &&
      refreshKey !== appliedRefresh.current
    ) {
      appliedRefresh.current = refreshKey;
      loadRef.current(directory.path, "replace");
    }
  }, [busy, connected, directory, refreshKey]);
  useEffect(() => {
    if (!busy) setCancelling(false);
  }, [busy]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const active = reviewRef.current;
      if (active)
        void managerApi.reject(profile.id, active.token).catch(() => {});
    };
  }, [profile.id]);
  const select = (path: string, shift = false, toggle = false) => {
    const next = clickSelection(
      idsRef.current,
      path,
      selected,
      anchor,
      shift,
      toggle,
    );
    setSelected(next.selected);
    setAnchor(next.anchor);
  };
  const open = (entry: RemoteEntry) => {
    if (busy || !connected) return;
    setDetails(null);
    if (entry.kind === "directory") load(entry.path);
    else if (entry.kind === "file") onOpen(entry.path);
    else
      setNotice(
        "Symbolic links and special files are not opened. Enter a directory-link path above to browse its canonical target.",
      );
  };
  const prepare = (input: OperationInput) => {
    setNotice("");
    setProgress(null);
    setResult(null);
    const action = () =>
      void run(
        `Review ${labels[input.kind].toLowerCase()}`,
        () => managerApi.review(profile.id, input),
        (value) => {
          if (value) setReview(value);
        },
      );
    if (input.kind === "move" || input.kind === "trash")
      beforeMutation(input.paths, action);
    else action();
  };
  const cancelReview = () => {
    if (busy) return;
    const current = review;
    setReview(null);
    if (current)
      void managerApi.reject(profile.id, current.token).catch(() => {});
  };
  const paste = () => {
    if (clipboard && directory)
      prepare({
        kind: clipboard.kind,
        paths: clipboard.paths,
        destination: directory.path,
        name: null,
      });
  };
  const calculate = (paths: string[]) =>
    void run(
      "Calculate folder sizes",
      async () => {
        const values: FolderSize[] = [];
        cancelRequested.current = false;
        for (const path of paths) {
          if (cancelRequested.current) break;
          values.push(await managerApi.size(profile.id, path));
        }
        return values;
      },
      (values) =>
        setSizes((old) =>
          Object.fromEntries(
            [
              ...Object.entries(old),
              ...values.map((value) => [value.path, value] as const),
            ].slice(-100),
          ),
        ),
    );
  const cancel = () => {
    cancelRequested.current = true;
    setCancelling(true);
    void managerApi
      .cancel(profile.id)
      .then((active) => {
        if (!active && mounted.current)
          setNotice(
            "The operation already finished, or the native file picker must be cancelled directly.",
          );
      })
      .catch(() =>
        setNotice(
          "Could not request cancellation. Check the current operation before retrying.",
        ),
      );
  };
  const beginBox = (event: PointerEvent<HTMLDivElement>) => {
    if (
      busy ||
      event.button !== 0 ||
      event.pointerType !== "mouse" ||
      (event.target as HTMLElement).closest(
        "button,input,[role=checkbox],[contenteditable]",
      )
    )
      return;
    const element = surface.current;
    if (!element) return;
    const bounds = element.getBoundingClientRect();
    if (event.clientX > bounds.right - 12) return;
    const start = {
      x: event.clientX - bounds.left + element.scrollLeft,
      y: event.clientY - bounds.top + element.scrollTop,
    };
    drag.current = {
      start,
      base: event.ctrlKey || event.metaKey ? selected : [],
      active: false,
      items: Array.from(
        element.querySelectorAll<HTMLElement>("[data-file-path]"),
      ).map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          path: node.dataset.filePath ?? "",
          box: {
            x: rect.left - bounds.left + element.scrollLeft,
            y: rect.top - bounds.top + element.scrollTop,
            width: rect.width,
            height: rect.height,
          },
        };
      }),
    };
  };
  const moveBox = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current,
      element = surface.current;
    if (!state || !element) return;
    const bounds = element.getBoundingClientRect();
    if (event.clientY > bounds.bottom - 20) element.scrollTop += 12;
    if (event.clientY < bounds.top + 20) element.scrollTop -= 12;
    const current = {
      x: event.clientX - bounds.left + element.scrollLeft,
      y: event.clientY - bounds.top + element.scrollTop,
    };
    if (
      !state.active &&
      Math.hypot(current.x - state.start.x, current.y - state.start.y) < 5
    )
      return;
    if (!state.active) element.setPointerCapture(event.pointerId);
    state.active = true;
    const selection = rectangle(state.start, current);
    setBox(selection);
    setSelected([
      ...new Set([
        ...state.base,
        ...state.items
          .filter((item) => intersect(selection, item.box))
          .map((item) => item.path),
      ]),
    ]);
    event.preventDefault();
  };
  const endBox = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.active) {
      skipClick.current = true;
      setTimeout(() => {
        skipClick.current = false;
      }, 0);
    }
    drag.current = null;
    setBox(null);
    if (surface.current?.hasPointerCapture(event.pointerId))
      surface.current.releasePointerCapture(event.pointerId);
  };
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      (event.target as HTMLElement).closest("input,[contenteditable]") ||
      busy
    )
      return;
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setSelected(idsRef.current);
      return;
    }
    if (modifier && ["c", "x"].includes(event.key.toLowerCase())) {
      event.preventDefault();
      if (selected.length)
        setClipboard({
          paths: [...selected],
          kind: event.key.toLowerCase() === "x" ? "move" : "copy",
        });
      return;
    }
    if (modifier && event.key.toLowerCase() === "v") {
      event.preventDefault();
      paste();
      return;
    }
    if (event.key === "Delete" && selected.length && !protectedSelection) {
      event.preventDefault();
      prepare({
        kind: "trash",
        paths: selected,
        destination: null,
        name: null,
      });
      return;
    }
    if (event.key === "Enter" && selected.length === 1) {
      event.preventDefault();
      const entry = entries.find((entry) => entry.path === selected[0]);
      if (entry) open(entry);
      return;
    }
    if (
      ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key) &&
      entries.length
    ) {
      event.preventDefault();
      const current = Math.max(
        -1,
        idsRef.current.indexOf(anchor ?? selected[selected.length - 1] ?? ""),
      );
      const next = Math.max(
        0,
        Math.min(
          entries.length - 1,
          current +
            (event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 1),
        ),
      );
      select(entries[next].path, event.shiftKey, modifier);
      surface.current
        ?.querySelector<HTMLElement>(
          `[data-file-path="${CSS.escape(entries[next].path)}"]`,
        )
        ?.focus();
    }
  };
  const finish = (approved: OperationReview) => {
    setReview(null);
    void run(
      labels[approved.operation],
      () => managerApi.execute(profile.id, approved.token, setProgress),
      (outcome) => {
        setResult(outcome);
        onCompleted(approved.operation, outcome);
        if (approved.operation === "move" && clipboard) {
          const paths = clipboard.paths.filter(
            (path) => !outcome.completed.some((item) => item.source === path),
          );
          setClipboard(paths.length ? { ...clipboard, paths } : null);
        }
        if (directory)
          setTimeout(() => {
            if (mounted.current) loadRef.current(directory.path, "replace");
          }, 0);
      },
    );
  };
  const downloadSelection = () => {
    if (selectedEntries.length === 1 && selectedEntries[0].kind === "file") {
      void run(
        "Download remote file",
        () => filesApi.download(profile.id, selectedEntries[0].path),
        (saved) =>
          setNotice(
            saved
              ? "Downloaded to your chosen location."
              : "Download cancelled.",
          ),
      );
    } else
      prepare({
        kind: "download",
        paths: selected,
        destination: null,
        name: null,
      });
  };
  const actions = (empty: boolean) => (
    <>
      {!empty && (
        <>
          <MenuItem
            disabled={busy || !connected || selectedEntries.length !== 1}
            onClick={() => open(selectedEntries[0])}
          >
            <File />
            Open
          </MenuItem>
          <MenuItem
            disabled={
              busy ||
              !connected ||
              !selected.length ||
              selectedEntries.some(
                (e) => e.kind === "other" || e.kind === "symlink",
              )
            }
            onClick={downloadSelection}
          >
            <Download />
            {selectedEntries.length === 1 && selectedEntries[0].kind === "file"
              ? "Download"
              : "Download ZIP"}
          </MenuItem>
          <MenuItem
            disabled={busy || !selected.length}
            onClick={() => setClipboard({ paths: [...selected], kind: "copy" })}
          >
            <Copy />
            Copy
          </MenuItem>
          <MenuItem
            disabled={busy || !selected.length || protectedSelection}
            onClick={() => setClipboard({ paths: [...selected], kind: "move" })}
          >
            <Scissors />
            Cut
          </MenuItem>
          <MenuItem
            disabled={
              busy || !connected || protectedSelection || selected.length !== 1
            }
            onClick={() => {
              setDialogValue(selectedEntries[0]?.name ?? "");
              setDialog("rename");
            }}
          >
            <Pencil />
            Rename
          </MenuItem>
          <MenuItem
            disabled={
              busy || !connected || !selected.length || protectedSelection
            }
            onClick={() => {
              setDialogValue(directory?.path ?? "/");
              setDialog("move");
            }}
          >
            <MoveRight />
            Move to…
          </MenuItem>
          <MenuItem
            disabled={selectedEntries.length !== 1}
            onClick={() => setDetails(selectedEntries[0])}
          >
            <Info />
            View details
          </MenuItem>
          <MenuItem
            className="text-destructive"
            disabled={
              busy || !connected || !selected.length || protectedSelection
            }
            onClick={() =>
              prepare({
                kind: "trash",
                paths: selected,
                destination: null,
                name: null,
              })
            }
          >
            <Trash2 />
            Move to trash
          </MenuItem>
        </>
      )}
      {empty && (
        <>
          <MenuItem
            disabled={busy || !connected || !directory}
            onClick={() => {
              setDialogValue("");
              setDialog("mkdir");
            }}
          >
            <FolderPlus />
            New folder
          </MenuItem>
          <MenuItem
            disabled={busy || !connected || !directory}
            onClick={() => directory && onUpload(directory.path)}
          >
            <Upload />
            Upload
          </MenuItem>
        </>
      )}
      <MenuItem
        disabled={busy || !connected || !clipboard || !directory}
        onClick={paste}
      >
        <ClipboardPaste />
        Paste
      </MenuItem>
      {empty && (
        <>
          <MenuItem
            disabled={busy || !connected || !directory}
            onClick={() => directory && load(directory.path, "replace")}
          >
            <RefreshCw />
            Refresh
          </MenuItem>
          <MenuItem onClick={() => setHidden(!hidden)}>
            {hidden ? "Hide hidden files" : "Show hidden files"}
          </MenuItem>
          <MenuItem onClick={() => setView(view === "list" ? "grid" : "list")}>
            Switch to {view === "list" ? "grid" : "list"} view
          </MenuItem>
        </>
      )}
    </>
  );
  return (
    <section aria-label="File manager" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={busy || !connected || !directory}
            onClick={() => directory && onUpload(directory.path)}
          >
            <Upload />
            Upload
          </Button>
          <Button
            variant="outline"
            disabled={busy || !connected || !directory}
            onClick={() => {
              setDialogValue("");
              setDialog("mkdir");
            }}
          >
            <FolderPlus />
            New folder
          </Button>
        </div>
        <div className="flex items-center gap-1">
          <Menu>
            <MenuTrigger render={<Button variant="ghost" size="sm" />}>
              View options
            </MenuTrigger>
            <MenuContent>
              <MenuItem
                onClick={() => {
                  setHidden(!hidden);
                  setSelected([]);
                }}
              >
                {hidden ? "Hide hidden files" : "Show hidden files"}
              </MenuItem>
              {(["name", "size", "modified"] as const).map((value) => (
                <MenuItem key={value} onClick={() => setSort(value)}>
                  Sort by {value}
                  {sort === value ? " ✓" : ""}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
          <Button
            variant="ghost"
            size="icon"
            aria-label="List view"
            aria-pressed={view === "list"}
            onClick={() => setView("list")}
          >
            <List />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Grid view"
            aria-pressed={view === "grid"}
            onClick={() => setView("grid")}
          >
            <Grid2X2 />
          </Button>
          <Menu>
            <MenuTrigger
              aria-label="File actions"
              render={<Button variant="ghost" size="icon" />}
            >
              <MoreHorizontal />
            </MenuTrigger>
            <MenuContent>{actions(!selected.length)}</MenuContent>
          </Menu>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1 rounded-lg border bg-card p-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back folder"
          disabled={busy || historyIndex <= 0}
          onClick={() =>
            load(history[historyIndex - 1], "replace", historyIndex - 1)
          }
        >
          <ArrowLeft />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Forward folder"
          disabled={busy || historyIndex >= history.length - 1}
          onClick={() =>
            load(history[historyIndex + 1], "replace", historyIndex + 1)
          }
        >
          <ArrowRight />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Parent folder"
          disabled={busy || !connected || !directory || directory.path === "/"}
          onClick={() => directory && load(directory.parent)}
        >
          <ArrowUp />
        </Button>
        {editPath ? (
          <form
            className="flex min-w-40 flex-1 gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy && connected) load(location);
            }}
          >
            <Input
              autoFocus
              aria-label="Remote folder path"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setLocation(directory?.path ?? "/");
                  setEditPath(false);
                }
              }}
            />
            <Button type="submit" size="sm" disabled={busy || !connected}>
              Go
            </Button>
          </form>
        ) : (
          <nav
            aria-label="Folder breadcrumbs"
            className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
          >
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => load("/")}
            >
              Root /
            </Button>
            {directory?.path
              .split("/")
              .filter(Boolean)
              .map((part, index, parts) => (
                <Button
                  key={parts.slice(0, index + 1).join("/")}
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    load(`/${parts.slice(0, index + 1).join("/")}`)
                  }
                >
                  {part}
                </Button>
              ))}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Edit folder path"
              disabled={busy}
              onClick={() => {
                setLocation(directory?.path ?? "/");
                setEditPath(true);
              }}
            >
              <Pencil />
            </Button>
          </nav>
        )}
        <div className="relative min-w-32 sm:w-48">
          <Search className="absolute left-2 top-2 size-4 text-muted-foreground" />
          <Input
            aria-label="Filter remote files"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected([]);
              setAnchor(null);
            }}
            placeholder="Search this folder…"
            className="pl-8"
          />
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Refresh folder"
          disabled={busy || !connected || !directory}
          onClick={() => directory && load(directory.path, "replace")}
        >
          <RefreshCw />
        </Button>
      </div>
      <div
        className="flex h-12 min-h-12 w-full items-center gap-2 overflow-x-auto overflow-y-hidden whitespace-nowrap text-xs text-muted-foreground"
        aria-label="Selection actions"
        role="group"
      >
        {selected.length ? (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Clear file selection"
              onClick={() => setSelected([])}
            >
              <X />
            </Button>
            <span>{selected.length} selected</span>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() =>
                setClipboard({ paths: [...selected], kind: "copy" })
              }
            >
              <Copy />
              Copy
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || !connected || protectedSelection}
              onClick={() => {
                setDialogValue(directory?.path ?? "/");
                setDialog("move");
              }}
            >
              <MoveRight />
              Move
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || !connected || protectedSelection}
              onClick={() =>
                prepare({
                  kind: "trash",
                  paths: selected,
                  destination: null,
                  name: null,
                })
              }
            >
              <Trash2 />
              Move to trash
            </Button>
          </>
        ) : (
          <span>
            {entries.length} items
            {directory?.truncated ? " · listing limited" : ""}
          </span>
        )}
      </div>
      {clipboard && (
        <p role="status" className="text-xs text-muted-foreground">
          {clipboard.paths.length} items ready to{" "}
          {clipboard.kind === "move" ? "move" : "copy"} on {profile.name}.
          Choose a folder and Paste.{" "}
          <button
            type="button"
            className="text-primary underline"
            onClick={() => setClipboard(null)}
          >
            Clear clipboard
          </button>
        </p>
      )}
      {busy && (
        <div
          role="group"
          aria-label="File operation progress"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card p-3"
        >
          <div className="min-w-0 text-xs">
            <p>
              {cancelling
                ? "Cancelling after the current SFTP request…"
                : progress
                  ? progress.completed +
                    " / " +
                    progress.total +
                    " items · " +
                    formatBytes(progress.bytes)
                  : "Working…"}
            </p>
            {progress?.current && (
              <p className="mt-1 truncate text-muted-foreground">
                {progress.current}
              </p>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={cancelling}
            onClick={cancel}
          >
            Cancel operation
          </Button>
        </div>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      {result && (
        <div
          role="status"
          className="space-y-2 rounded-lg border bg-card p-3 text-xs"
        >
          <p
            className={
              result.status === "failed" ? "text-destructive" : "text-primary"
            }
          >
            {result.status === "completed"
              ? "Operation completed"
              : result.status === "cancelled"
                ? "Operation cancelled"
                : "Operation stopped"}{" "}
            · {result.completed.length} items completed
            {result.error ? ` · ${result.error}` : ""}
          </p>
          {result.status !== "completed" && (
            <p className="text-muted-foreground">
              Completed changes remain applied. No automatic retry.
            </p>
          )}
          {result.retained.map((path) => (
            <p key={path} className="break-all text-muted-foreground">
              Private retained data: {path}
            </p>
          ))}
          {result.completed.some((item) => item.restoreId) && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !connected}
              onClick={() =>
                prepare({
                  kind: "restore",
                  paths: result.completed.flatMap((item) =>
                    item.restoreId ? [item.restoreId] : [],
                  ),
                  destination: null,
                  name: null,
                })
              }
            >
              <Undo2 />
              Restore deleted items
            </Button>
          )}
        </div>
      )}
      <div
        className={
          editor || details
            ? "grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(280px,0.65fr)]"
            : "min-w-0"
        }
      >
        <ContextMenu>
          <ContextMenuTrigger
            ref={surface}
            onContextMenuCapture={(event) => {
              const path = (event.target as HTMLElement).closest<HTMLElement>(
                "[data-file-path]",
              )?.dataset.filePath;
              setContextEmpty(!path);
              if (path && !selected.includes(path)) {
                setSelected([path]);
                setAnchor(path);
              } else if (!path) setSelected([]);
            }}
            role="grid"
            aria-label="Remote files"
            aria-multiselectable="true"
            tabIndex={0}
            className="relative min-h-72 max-h-[65dvh] min-w-0 overflow-auto rounded-xl border bg-card p-3 outline-none select-none focus-visible:ring-2 focus-visible:ring-ring"
            onKeyDown={keyboard}
            onPointerDown={beginBox}
            onPointerMove={moveBox}
            onPointerUp={endBox}
            onPointerCancel={endBox}
            onClick={(event) => {
              if (
                !skipClick.current &&
                !(event.target as HTMLElement).closest(
                  "[data-file-path],button,input,[role=checkbox]",
                ) &&
                !event.ctrlKey &&
                !event.metaKey
              )
                setSelected([]);
            }}
          >
            {directory ? (
              <>
                {view === "list" && (
                  <div
                    role="row"
                    tabIndex={-1}
                    className="mb-1 grid grid-cols-[28px_minmax(120px,1fr)_90px] gap-2 border-b px-2 py-2 text-[11px] text-muted-foreground"
                  >
                    <span role="columnheader" tabIndex={-1}>
                      <Checkbox
                        aria-label="Select all files"
                        checked={
                          entries.length > 0 &&
                          entries.every((entry) =>
                            selected.includes(entry.path),
                          )
                        }
                        onCheckedChange={(value) =>
                          setSelected(value ? idsRef.current : [])
                        }
                      />
                    </span>
                    <span role="columnheader" tabIndex={-1}>
                      Name
                    </span>
                    <span role="columnheader" tabIndex={-1}>
                      Size
                    </span>
                  </div>
                )}
                <div
                  className={
                    view === "grid"
                      ? "grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-3"
                      : "space-y-1"
                  }
                >
                  {entries.map((entry) => {
                    const chosen = selected.includes(entry.path),
                      locked = entry.protected ?? protectedPath(entry.path),
                      size = sizes[entry.path];
                    return (
                      <div
                        key={entry.path}
                        role="row"
                        aria-selected={chosen}
                        data-file-path={entry.path}
                        tabIndex={-1}
                        className={
                          "group rounded-lg border outline-none " +
                          (chosen
                            ? "border-primary/60 bg-primary/10"
                            : "border-transparent hover:bg-muted/35") +
                          " " +
                          (clipboard?.kind === "move" &&
                          clipboard.paths.includes(entry.path)
                            ? "opacity-50 "
                            : "") +
                          (view === "grid"
                            ? "relative flex min-h-36 flex-col items-center gap-2 p-3 text-center"
                            : "grid grid-cols-[28px_minmax(120px,1fr)_90px] items-center gap-2 px-2 py-2")
                        }
                        onClick={(event) => {
                          if (skipClick.current || busy) return;
                          if (event.shiftKey || event.ctrlKey || event.metaKey)
                            select(
                              entry.path,
                              event.shiftKey,
                              event.ctrlKey || event.metaKey,
                            );
                          else open(entry);
                        }}
                        onKeyDown={keyboard}
                      >
                        <div
                          role="gridcell"
                          tabIndex={-1}
                          className={
                            (view === "grid" ? "absolute top-2 left-2 " : "") +
                            (selected.length
                              ? ""
                              : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100")
                          }
                        >
                          <Checkbox
                            onClick={(event) => event.stopPropagation()}
                            aria-label={`Select ${entry.name}`}
                            checked={chosen}
                            disabled={busy}
                            onCheckedChange={() =>
                              select(entry.path, false, true)
                            }
                          />
                        </div>
                        <div role="gridcell" tabIndex={-1} className="min-w-0">
                          <Button
                            variant="ghost"
                            className={
                              "h-auto max-w-full whitespace-normal p-0 text-left " +
                              (view === "grid"
                                ? "flex-col gap-2"
                                : "justify-start gap-2")
                            }
                            disabled={busy}
                            onClick={(event) => {
                              event.stopPropagation();
                              if (
                                event.shiftKey ||
                                event.ctrlKey ||
                                event.metaKey
                              )
                                select(
                                  entry.path,
                                  event.shiftKey,
                                  event.ctrlKey || event.metaKey,
                                );
                              else open(entry);
                            }}
                          >
                            {entry.kind === "directory" ? (
                              <Folder
                                className={
                                  "text-primary " +
                                  (view === "grid" ? "size-10" : "size-4")
                                }
                              />
                            ) : (
                              <File
                                className={
                                  view === "grid"
                                    ? "size-9 text-muted-foreground"
                                    : "size-4 text-muted-foreground"
                                }
                              />
                            )}
                            <span className="break-all text-xs">
                              {entry.name}
                            </span>
                            {locked && (
                              <LockKeyhole className="size-3 text-muted-foreground" />
                            )}
                            {entry.kind === "symlink" && (
                              <span className="text-[10px] text-muted-foreground">
                                link
                              </span>
                            )}
                          </Button>
                        </div>
                        <div
                          role="gridcell"
                          tabIndex={-1}
                          className="text-xs tabular-nums text-muted-foreground"
                        >
                          {entry.kind === "directory"
                            ? size
                              ? formatBytes(size.bytes)
                              : "Folder"
                            : entry.size === null
                              ? "—"
                              : formatBytes(entry.size)}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {entries.length === 0 && (
                  <p className="p-10 text-center text-sm text-muted-foreground">
                    This folder is empty or no items match your search.
                  </p>
                )}
              </>
            ) : (
              <p className="p-10 text-center text-sm text-muted-foreground">
                {connected
                  ? "Loading root folder…"
                  : "Connect this VPS to browse files."}
              </p>
            )}
            {box && (
              <div
                data-testid="file-selection-rectangle"
                className="pointer-events-none absolute z-20 border border-primary bg-primary/15"
                style={{
                  left: box.x,
                  top: box.y,
                  width: box.width,
                  height: box.height,
                }}
              />
            )}
          </ContextMenuTrigger>
          <ContextMenuContent>{actions(contextEmpty)}</ContextMenuContent>
        </ContextMenu>
        <div className={details ? "hidden" : "contents"}>{editor}</div>
        {details && (
          <aside
            aria-label="File details"
            className="min-w-0 space-y-4 rounded-xl border bg-card p-4"
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="break-all text-sm font-semibold">
                {details.name}
              </h3>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Close file details"
                onClick={() => setDetails(null)}
              >
                <X />
              </Button>
            </div>
            <dl className="space-y-3 break-all text-xs">
              <div>
                <dt className="text-muted-foreground">Path</dt>
                <dd>{details.path}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Type</dt>
                <dd>{details.kind}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Size</dt>
                <dd>
                  {details.kind === "directory"
                    ? sizes[details.path]
                      ? (sizes[details.path].complete ? "" : "At least ") +
                        formatBytes(sizes[details.path].bytes)
                      : "Not calculated"
                    : details.size === null
                      ? "Unknown"
                      : formatBytes(details.size)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Permissions</dt>
                <dd>{mode(details.permissions)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Owner / Group</dt>
                <dd>
                  {details.uid ?? "Unknown"} / {details.gid ?? "Unknown"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Modified</dt>
                <dd>
                  {details.modified !== null
                    ? new Date(details.modified * 1000).toLocaleString()
                    : "Unknown"}
                </dd>
              </div>
            </dl>
            {(details.protected ?? protectedPath(details.path)) && (
              <p className="text-xs text-muted-foreground">
                Protected from app writes.
              </p>
            )}
            {sizes[details.path] && (
              <p className="text-xs text-muted-foreground">
                Size observed{" "}
                {new Date(
                  sizes[details.path].observedAt * 1000,
                ).toLocaleString()}
                . File-byte total; symbolic-link targets excluded.
              </p>
            )}
            {details.kind === "directory" && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy || !connected}
                onClick={() => calculate([details.path])}
              >
                <Calculator />
                Calculate size
              </Button>
            )}
            <p className="text-xs text-muted-foreground">
              Metadata from the current listing.
            </p>
          </aside>
        )}
      </div>
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialog === "move"
                ? "Move selected items"
                : dialog === "rename"
                  ? "Rename item"
                  : "New folder"}
            </DialogTitle>
            <DialogDescription>
              {profile.name} ·{" "}
              {dialog === "move"
                ? "Enter an absolute destination folder."
                : "Choose a name. Existing items will not be overwritten."}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!directory) return;
              const kind = dialog === "mkdir" ? "mkdir" : "move";
              prepare({
                kind,
                paths: kind === "mkdir" ? [] : selected,
                destination: dialog === "move" ? dialogValue : directory.path,
                name: dialog === "move" ? null : dialogValue,
              });
              setDialog(null);
            }}
          >
            <Input
              aria-label={
                dialog === "move" ? "Destination folder" : "Item name"
              }
              autoFocus
              value={dialogValue}
              onChange={(event) => setDialogValue(event.target.value)}
            />
            <DialogFooter>
              <DialogClose render={<Button variant="outline" />}>
                Cancel
              </DialogClose>
              <Button type="submit" disabled={!dialogValue.trim()}>
                Review operation
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={review !== null}
        onOpenChange={(open) => {
          if (!open) cancelReview();
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {review
                ? `Confirm ${labels[review.operation].toLowerCase()}`
                : "Confirm file operation"}
            </DialogTitle>
            <DialogDescription>
              {profile.name} · {review?.entries.toLocaleString()} entries ·{" "}
              {formatBytes(review?.bytes ?? 0)}
            </DialogDescription>
          </DialogHeader>
          {review && (
            <>
              <div className="max-h-64 space-y-3 overflow-y-auto rounded-lg border p-3">
                {review.items.map((item) => (
                  <div
                    key={item.source || item.destination || "new-folder"}
                    className="space-y-1 break-all text-xs"
                  >
                    <p>{item.source || "New folder"}</p>
                    {item.destination && (
                      <p className="text-primary">→ {item.destination}</p>
                    )}
                  </div>
                ))}
              </div>
              {review.localDestination && (
                <p className="break-all text-xs">
                  Local archive: {review.localDestination}
                </p>
              )}
              {review.excludedEntries > 0 && (
                <p className="text-xs text-muted-foreground">
                  {review.excludedEntries} internal or symbolic-link entries
                  excluded from copying/download.
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                {review.operation === "trash"
                  ? "Items move into private server trash and keep using disk space. Restore is available during this SSH session; copies remain afterward."
                  : "Existing destinations are not overwritten. Copies preserve ordinary mode bits; ACLs and extended attributes are not copied."}{" "}
                Cancellation stops remaining work; completed changes stay
                applied.
              </p>
              <DialogFooter>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={cancelReview}
                >
                  Cancel
                </Button>
                <Button
                  variant={
                    review.operation === "trash" ? "destructive" : "default"
                  }
                  disabled={busy || !connected}
                  onClick={() => finish(review)}
                >
                  Confirm {labels[review.operation].toLowerCase()}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

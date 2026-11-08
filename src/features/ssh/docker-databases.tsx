import { Channel, invoke } from "@tauri-apps/api/core";
import { useEffect, useId, useRef, useState } from "react";
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
import { useCommandActivity } from "./command-activity";
import { useConfiguration } from "./configuration-context";
import type { ContainerRow } from "./docker-view";
import { formatBytes } from "./structured-report";

type Engine = "postgres" | "mysql" | "mariadb" | "mongodb";
const engines: { value: Engine; label: string }[] = [
  { value: "postgres", label: "PostgreSQL" },
  { value: "mysql", label: "MySQL" },
  { value: "mariadb", label: "MariaDB" },
  { value: "mongodb", label: "MongoDB" },
];
interface Inventory {
  databases: string[];
  engineId: string;
  imageId: string;
  startedAt: string;
}
interface Receipt {
  bytes: number;
  sha256: string;
  destination: string;
}
export function DockerDatabases({
  profile,
  connected,
  active,
  containers,
}: {
  profile: ServerProfile;
  connected: boolean;
  active: boolean;
  containers: ContainerRow[];
}) {
  const { connectionId } = useConfiguration();
  const log = useCommandActivity();
  const prefix = useId();
  const [container, setContainer] = useState("");
  const [engine, setEngine] = useState<Engine>("postgres");
  const [username, setUsername] = useState("postgres");
  const [password, setPassword] = useState("");
  const [authDatabase, setAuthDatabase] = useState("admin");
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [database, setDatabase] = useState("");
  const [busy, setBusy] = useState<"list" | "backup" | null>(null);
  const [bytes, setBytes] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [review, setReview] = useState(false);
  const operation = useRef<string | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const secretContext = useRef("");
  const context = JSON.stringify([profile.id, profile.revision, connectionId]);
  useEffect(() => {
    if (!context) return;
    generation.current += 1;
    setPassword("");
    setInventory(null);
    setDatabase("");
    setReview(false);
    setReceipt(null);
    const running = operation.current;
    if (running)
      void invoke("ssh_database_cancel", {
        profileId: profile.id,
        operationId: running,
      }).catch(() => {});
  }, [context, profile.id]);
  useEffect(() => {
    if (!active) {
      setPassword("");
      setReview(false);
    }
  }, [active]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const running = operation.current;
      if (running)
        void invoke("ssh_database_cancel", {
          profileId: profile.id,
          operationId: running,
        }).catch(() => {});
    };
  }, [profile.id]);
  function change(action: () => void) {
    if (busy) return;
    generation.current += 1;
    action();
    setPassword("");
    setInventory(null);
    setDatabase("");
    setReview(false);
    setReceipt(null);
    setError("");
  }
  const running = containers.filter((row) => row.state === "running");
  const selected = running.find((row) => row.id === container);
  const ready = connected && Boolean(connectionId && selected) && !busy;
  function request() {
    return {
      profileId: profile.id,
      profileRevision: profile.revision,
      connectionId,
      container,
      engine,
      username,
      password: secretContext.current === context ? password : "",
      authDatabase,
      database,
      ...(inventory
        ? {
            engineId: inventory.engineId,
            imageId: inventory.imageId,
            startedAt: inventory.startedAt,
          }
        : {}),
    };
  }
  async function list() {
    if (!ready || operation.current) return;
    const id = crypto.randomUUID();
    operation.current = id;
    const version = generation.current;
    setBusy("list");
    setError("");
    setNotice("");
    setInventory(null);
    setDatabase("");
    setReceipt(null);
    const activity = log.begin(
      "List container databases",
      "Docker database discovery (credentials sent privately)",
    );
    try {
      const result = await invoke<Inventory>("ssh_database_list", {
        request: request(),
        operationId: id,
      });
      if (!mounted.current || version !== generation.current) {
        log.update(activity, {
          status: "completed",
          ended: Date.now(),
          message:
            "Database discovery finished for the previous connection; evidence discarded.",
          code: 0,
        });
        return;
      }
      if (
        !Array.isArray(result.databases) ||
        result.databases.length > 1000 ||
        result.databases.some((name) => typeof name !== "string") ||
        !result.engineId ||
        !result.imageId ||
        !result.startedAt
      )
        throw Error("Unsupported database inventory. List again.");
      setInventory(result);
      setNotice(
        `${result.databases.length} databases found. Choose one to download.`,
      );
      log.update(activity, {
        status: "completed",
        ended: Date.now(),
        message: "Database discovery completed; credentials omitted.",
        code: 0,
      });
    } catch (failure) {
      if (mounted.current) setError(safeError(failure));
      log.update(activity, {
        status: "failed",
        ended: Date.now(),
        message:
          "Database discovery failed. See the database view for connection/tool guidance.",
        code: null,
      });
    } finally {
      operation.current = null;
      if (mounted.current) setBusy(null);
    }
  }
  async function backup() {
    if (!ready || !inventory?.databases.includes(database) || operation.current)
      return;
    const id = crypto.randomUUID();
    operation.current = id;
    const version = generation.current;
    setReview(false);
    setBusy("backup");
    setError("");
    setReceipt(null);
    setNotice("Choose a new local filename in the save dialog.");
    setBytes(0);
    const progress = new Channel<{ bytes: number }>();
    progress.onmessage = (event) => {
      if (mounted.current && operation.current === id) setBytes(event.bytes);
    };
    const activity = log.begin(
      "Download database backup",
      "Native database dump → private local file (credentials and database contents omitted)",
    );
    try {
      const result = await invoke<Receipt | null>("ssh_database_backup", {
        request: request(),
        operationId: id,
        progress,
      });
      if (mounted.current && version === generation.current) {
        setReceipt(result);
        setNotice(
          result
            ? "Backup downloaded. Verify restoration before relying on it for recovery."
            : "Save canceled. No backup was downloaded.",
        );
      }
      log.update(activity, {
        status: result ? "completed" : "cancelled",
        ended: Date.now(),
        message: result
          ? "Logical backup downloaded successfully; contents omitted."
          : "Save dialog canceled.",
        code: result ? 0 : null,
      });
    } catch (failure) {
      if (mounted.current) {
        setError(safeError(failure));
        setNotice("");
        setInventory(null);
      }
      log.update(activity, {
        status: "failed",
        ended: Date.now(),
        message:
          "Backup did not complete. No complete local backup was published.",
        code: null,
      });
    } finally {
      operation.current = null;
      if (mounted.current) setBusy(null);
    }
  }
  async function cancel() {
    const id = operation.current;
    if (!id) return;
    try {
      await invoke("ssh_database_cancel", {
        profileId: profile.id,
        operationId: id,
      });
      setNotice(
        "Cancellation requested. Close the save dialog if it is still open.",
      );
    } catch (failure) {
      setError(safeError(failure));
    }
  }
  const format =
    engine === "postgres"
      ? "PostgreSQL custom archive (.dump), restored with pg_restore."
      : engine === "mongodb"
        ? "MongoDB gzip archive (.archive.gz), restored with mongorestore --archive --gzip."
        : "SQL dump (.sql), restored with the matching MySQL/MariaDB client. Transactional tables use a consistent snapshot; nontransactional tables and concurrent schema changes need separate coordination.";
  return (
    <section aria-label="Docker databases" className="min-w-0 space-y-5">
      <div>
        <h2 className="text-lg font-medium">Databases</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect inside a running container and download a logical backup. No
          database port is exposed.
        </p>
      </div>
      {!running.length && (
        <p role="status" className="text-sm text-warning">
          Refresh Docker inventory to find running containers. Choose the
          database container, not an application or proxy.
        </p>
      )}
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor={`${prefix}-container`} className="block text-sm">
            Container
          </label>
          <Select
            value={container}
            disabled={Boolean(busy)}
            onValueChange={(value) => change(() => setContainer(value ?? ""))}
            items={running.map((row) => ({
              value: row.id,
              label: `${row.name} · ${row.image}`,
            }))}
          >
            <SelectTrigger
              id={`${prefix}-container`}
              className="w-full min-w-0"
            >
              <SelectValue placeholder="Choose a running database container" />
            </SelectTrigger>
            <SelectContent>
              {running.map((row) => (
                <SelectItem key={row.id} value={row.id}>
                  {row.name} · {row.image}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <label htmlFor={`${prefix}-engine`} className="block text-sm">
            Database engine
          </label>
          <Select
            value={engine}
            disabled={Boolean(busy)}
            onValueChange={(value) =>
              change(() => {
                setEngine(value as Engine);
                setUsername(
                  value === "postgres"
                    ? "postgres"
                    : value === "mongodb"
                      ? ""
                      : "root",
                );
              })
            }
            items={engines}
          >
            <SelectTrigger id={`${prefix}-engine`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {engines.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <label htmlFor={`${prefix}-user`} className="block text-sm">
            Database username
          </label>
          <Input
            id={`${prefix}-user`}
            value={username}
            maxLength={256}
            disabled={Boolean(busy)}
            autoComplete="off"
            placeholder={
              engine === "postgres"
                ? "postgres"
                : engine === "mongodb"
                  ? "Optional for unauthenticated databases"
                  : "root"
            }
            onChange={(event) => change(() => setUsername(event.target.value))}
          />
        </div>
        <div className="space-y-2">
          <label htmlFor={`${prefix}-password`} className="block text-sm">
            Database password
          </label>
          <Input
            id={`${prefix}-password`}
            type="password"
            value={password}
            maxLength={4096}
            disabled={Boolean(busy)}
            autoComplete="new-password"
            onChange={(event) => {
              secretContext.current = context;
              setPassword(event.target.value);
              setError("");
            }}
          />
          <p className="text-xs text-muted-foreground">
            Used only for this connection. Never saved. Blank is allowed when
            database authentication permits it.
          </p>
        </div>
        {engine === "mongodb" && (
          <div className="space-y-2">
            <label htmlFor={`${prefix}-auth`} className="block text-sm">
              Authentication database
            </label>
            <Input
              id={`${prefix}-auth`}
              value={authDatabase}
              maxLength={256}
              disabled={Boolean(busy)}
              onChange={(event) =>
                change(() => setAuthDatabase(event.target.value))
              }
            />
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button disabled={!ready} onClick={() => void list()}>
          {busy === "list"
            ? "Listing databases…"
            : inventory
              ? "Refresh databases"
              : "List databases"}
        </Button>
        {busy && (
          <Button variant="outline" onClick={() => void cancel()}>
            Cancel operation
          </Button>
        )}
      </div>
      {error && (
        <p
          role="alert"
          className="text-sm text-destructive [overflow-wrap:anywhere]"
        >
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      {busy === "backup" && (
        <p role="status" className="text-sm">
          Received {formatBytes(bytes)} · streaming directly to a private local
          file
        </p>
      )}
      {inventory && (
        <div className="space-y-3 rounded-xl border p-4">
          <label htmlFor={`${prefix}-database`} className="block text-sm">
            Database to back up
          </label>
          <Select
            value={database}
            disabled={Boolean(busy)}
            onValueChange={(value) => {
              setDatabase(value ?? "");
              setReceipt(null);
            }}
            items={inventory.databases.map((value) => ({
              value,
              label: value,
            }))}
          >
            <SelectTrigger id={`${prefix}-database`} className="w-full">
              <SelectValue placeholder="Choose a database" />
            </SelectTrigger>
            <SelectContent>
              {inventory.databases.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{format}</p>
          <Button
            disabled={!ready || !database}
            onClick={() => setReview(true)}
          >
            Review backup download
          </Button>
        </div>
      )}
      {receipt && (
        <div
          role="status"
          className="space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-4 text-sm"
        >
          <p className="font-medium text-primary">
            Backup downloaded · {formatBytes(receipt.bytes)}
          </p>
          <p className="[overflow-wrap:anywhere]">{receipt.destination}</p>
          <p className="text-xs [overflow-wrap:anywhere]">
            SHA-256: {receipt.sha256}
          </p>
        </div>
      )}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">
          Backup requirements and limits
        </summary>
        <p className="mt-2 leading-relaxed">
          Requires Python 3 and Docker socket access on the VPS, plus
          psql/pg_dump, mysql/mysqldump, mariadb/mariadb-dump or
          mongosh/mongodump inside the selected container. Uses localhost and
          standard database ports inside that container. Credentials with
          control characters are unsupported. Maximum download: 100 GiB or one
          hour. Existing local files are never overwritten. These are individual
          database backups, not volumes, cluster-wide users/roles or a guarantee
          of point-in-time recovery. Keep backups private and test restoration
          with compatible tool versions.
        </p>
      </details>
      <Dialog open={review} onOpenChange={setReview}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] min-w-0 overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Download database backup</DialogTitle>
            <DialogDescription className="[overflow-wrap:anywhere]">
              {profile.name} · {selected?.name} · {database}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm">{format}</p>
          <p className="text-xs text-muted-foreground">
            The next dialog chooses a new local destination. Database contents
            are streamed over your existing SSH connection and are not stored in
            app history or staged on the VPS. This can add load to the database.
          </p>
          <DialogFooter className="flex-wrap gap-2">
            <Button variant="outline" onClick={() => setReview(false)}>
              Cancel
            </Button>
            <Button
              disabled={!ready || !inventory || !database}
              onClick={() => void backup()}
            >
              Choose destination and download
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

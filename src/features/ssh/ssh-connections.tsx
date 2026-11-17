import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { type ConnectionStatus, type ServerProfile, safeError } from "./api";

interface Snapshot {
  port: number;
  connections: { peer: string; port: number; local: string }[];
  error?: string;
}
export function SshConnections({
  profile,
  status,
  active,
}: {
  profile: ServerProfile;
  status?: ConnectionStatus;
  active: boolean;
}) {
  const [open, setOpen] = useState(false);
  const connected = status?.status === "connected" && !!status.connectionId;
  const query = useQuery({
    queryKey: ["ssh", "incoming", profile.id, status?.connectionId],
    queryFn: async () => {
      const result = await invoke<Snapshot>("ssh_incoming_connections", {
        profileId: profile.id,
        connectionId: status?.connectionId,
      });
      if (result.error) throw Error(result.error);
      return result;
    },
    enabled: active && connected,
    staleTime: 15000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const data = connected ? query.data : undefined;
  return (
    <details
      className="relative"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer list-none rounded-md px-2 py-1 text-xs hover:bg-accent">
        SSH · {data?.connections.length ?? "—"}
      </summary>
      <div className="absolute right-0 top-full z-30 mt-2 w-72 max-w-[85vw] space-y-3 rounded-xl border bg-popover p-4 text-xs shadow-lg">
        <p className="font-medium">{profile.name} · Incoming SSH</p>
        {!connected ? (
          <p>Disconnected</p>
        ) : (
          <>
            {query.error ? (
              <p role="alert">{safeError(query.error)}</p>
            ) : data ? (
              <>
                <p className="text-muted-foreground">
                  Established TCP connections · SSH port {data.port}. Includes
                  other users and devices; connections may still be
                  authenticating.
                </p>
                <div className="max-h-48 overflow-auto">
                  {data.connections.map((item) => (
                    <p
                      className="break-all"
                      key={`${item.local}-${item.peer}-${item.port}`}
                    >
                      {item.peer}:{item.port}
                    </p>
                  ))}
                </div>
                <p className="text-muted-foreground">
                  Snapshot ·{" "}
                  {new Date(query.dataUpdatedAt).toLocaleTimeString()}
                </p>
              </>
            ) : (
              <p>
                {query.isFetching ? "Checking…" : "Check incoming connections."}
              </p>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              {query.isFetching
                ? "Checking…"
                : query.error
                  ? "Retry"
                  : "Refresh"}
            </Button>
          </>
        )}
      </div>
    </details>
  );
}

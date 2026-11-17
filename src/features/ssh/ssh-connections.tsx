import { useConnectionStatuses, useServerProfiles } from "./api";
export function SshConnections() {
  const { data: statuses } = useConnectionStatuses(true);
  const { data: profiles } = useServerProfiles();
  const connected = statuses?.filter((s) => s.status === "connected") ?? [];
  return (
    <details className="relative">
      <summary className="cursor-pointer list-none rounded-md px-2 py-1 text-xs hover:bg-accent">
        SSH · {connected.length}
      </summary>
      <div className="absolute right-0 top-full z-30 mt-2 w-72 max-w-[85vw] space-y-3 rounded-xl border bg-popover p-4 text-xs shadow-lg">
        {connected.length
          ? connected.map((s) => {
              const p = profiles?.find((p) => p.id === s.profileId);
              return (
                <div key={s.profileId}>
                  <p className="font-medium">
                    {p?.name ?? "Server"} · Connected
                  </p>
                  <p className="break-all text-muted-foreground">
                    {p
                      ? `${p.username}@${p.host}:${p.port}`
                      : "Connection details unavailable"}
                  </p>
                </div>
              );
            })
          : "No active SSH connections."}
      </div>
    </details>
  );
}

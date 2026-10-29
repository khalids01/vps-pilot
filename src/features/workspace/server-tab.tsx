import { useSortable } from "@dnd-kit/react/sortable";
import { GripVertical, Server, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TabsTrigger } from "@/components/ui/tabs";
import type { ConnectionStatus } from "@/features/ssh/api";
import type { SampleServer } from "./fixtures";

export function ServerTab({
  server,
  index,
  onClose,
}: {
  server: Pick<SampleServer, "id" | "name"> & {
    detail?: string;
    connectionStatus?: ConnectionStatus["status"];
  };
  index: number;
  onClose: () => void;
}) {
  const { ref, handleRef, isDragging } = useSortable({
    id: server.id,
    index,
    group: "vps-tabs",
    type: "vps-tab",
    accept: "vps-tab",
  });
  return (
    <div
      ref={ref}
      className={`relative shrink-0 ${isDragging ? "z-20 opacity-80" : ""}`}
    >
      <TabsTrigger
        id={`tab-${server.id}`}
        value={server.id}
        aria-label={
          server.detail ? `${server.name} · ${server.detail}` : server.name
        }
        className="pr-10 pl-8"
      >
        <Server className="size-3.5" aria-hidden="true" />
        {server.name}
        {server.detail && (
          <span
            aria-hidden="true"
            className={`text-[10px] ${server.connectionStatus === "connected" ? "text-primary" : "text-muted-foreground"}`}
          >
            SSH{server.connectionStatus === "connected" ? " ●" : ""}
          </span>
        )}
      </TabsTrigger>
      <Button
        ref={handleRef}
        variant="ghost"
        size="icon-xs"
        aria-label={`Reorder ${server.name} tab`}
        aria-describedby="server-reorder-help"
        className="absolute top-2 left-1 touch-none cursor-grab text-muted-foreground active:cursor-grabbing"
      >
        <GripVertical aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Close ${server.name} ${server.detail ? "SSH" : "sample"} tab`}
        className="absolute top-2 right-1.5 text-muted-foreground"
        onClick={onClose}
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  );
}

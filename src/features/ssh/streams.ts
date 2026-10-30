import { Channel, invoke } from "@tauri-apps/api/core";
import type { MetricSample } from "./live-metrics-data";
import type { InspectionReport } from "./report-types";

export type StreamEvent =
  | { type: "metrics"; id: string; sequence: number; sample: MetricSample }
  | { type: "inspection"; id: string; report: InspectionReport }
  | { type: "data"; id: string; sequence: number; data: number[] }
  | { type: "closed"; id: string; code: number | null; message: string };
export type InspectionKind =
  | "overview"
  | "software"
  | "docker"
  | "proxy"
  | "services"
  | "storage"
  | "firewall"
  | "network"
  | "processes";
export const streamApi = {
  describeMonitor: () => invoke<string>("ssh_monitor_describe"),
  monitor: (
    profileId: string,
    intervalSeconds: number,
    receive: (event: StreamEvent) => void,
  ) => {
    const output = new Channel<StreamEvent>();
    output.onmessage = receive;
    return invoke<{ id: string; command: string }>("ssh_monitor_start", {
      profileId,
      intervalSeconds,
      output,
    });
  },
  describe: (kind: InspectionKind) =>
    invoke<string>("ssh_inspection_describe", { kind }),
  terminal: (
    profileId: string,
    cols: number,
    rows: number,
    receive: (event: StreamEvent) => void,
  ) => {
    const output = new Channel<StreamEvent>();
    output.onmessage = receive;
    return invoke<string>("ssh_terminal_open", {
      profileId,
      cols,
      rows,
      output,
    });
  },
  inspect: (
    profileId: string,
    kind: InspectionKind,
    receive: (event: StreamEvent) => void,
  ) => {
    const output = new Channel<StreamEvent>();
    output.onmessage = receive;
    return invoke<{ id: string; command: string }>("ssh_inspection_run", {
      profileId,
      kind,
      output,
    });
  },
  input: (profileId: string, id: string, data: Uint8Array) =>
    invoke<void>("ssh_terminal_input", {
      profileId,
      id,
      data: Array.from(data),
    }),
  resize: (profileId: string, id: string, cols: number, rows: number) =>
    invoke<void>("ssh_terminal_resize", { profileId, id, cols, rows }),
  ack: (profileId: string, id: string, sequence: number) =>
    invoke<void>("ssh_stream_ack", { profileId, id, sequence }),
  close: (profileId: string, id: string) =>
    invoke<void>("ssh_stream_close", { profileId, id }),
};

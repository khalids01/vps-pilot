export interface InspectionSection {
  title: string;
  columns: string[];
  rows: string[][];
  state: "ready" | "empty" | "partial" | "unavailable";
  message: string | null;
  truncated: boolean;
}
export interface InspectionReport {
  sections: InspectionSection[];
  overview: {
    os: string | null;
    architecture: string | null;
    memoryTotal: number | null;
    memoryAvailable: number | null;
    cpuTotal: number | null;
    cpuIdle: number | null;
  } | null;
}

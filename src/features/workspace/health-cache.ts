import { create } from "zustand";
import type { MetricPoint } from "@/features/ssh/live-metrics-data";

export interface CachedHealth {
  revision: string;
  point: MetricPoint;
  capacityTime: number;
}
export const useFleetHealth = create<{
  servers: Record<string, CachedHealth>;
  remember: (id: string, health: CachedHealth) => void;
}>((set) => ({
  servers: {},
  remember: (id, health) =>
    set((state) => ({
      servers: Object.fromEntries(
        [
          ...Object.entries(state.servers).filter(([key]) => key !== id),
          [id, health],
        ].slice(-100),
      ),
    })),
}));

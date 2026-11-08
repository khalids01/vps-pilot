import type { ConfigurationSnapshot } from "./configuration-model";
import { quickSetupCatalogEntry } from "./quick-setup-catalog";
import {
  type QuickSetupDraft,
  type QuickSetupStepId,
  resolveQuickSetupPlan,
} from "./quick-setup-model";

export const setupCheckpointPrefix = "vps-pilot:setup-checkpoints:v1:";
export interface SetupCheckpoint {
  step: QuickSetupStepId;
  at: number;
  phase: "scanned" | "reviewed";
}
export function parseSetupCheckpoints(
  raw: string | null,
): SetupCheckpoint[] | null {
  if (raw === null) return [];
  try {
    if (raw.length > 1024) return null;
    const value = JSON.parse(raw);
    if (
      value.version !== 1 ||
      Object.keys(value).sort().join() !== "steps,version" ||
      !Array.isArray(value.steps) ||
      value.steps.length > 8
    )
      return null;
    const seen = new Set<number>();
    for (const item of value.steps) {
      if (
        Object.keys(item).sort().join() !== "at,phase,step" ||
        !Number.isInteger(item.step) ||
        item.step < 1 ||
        item.step > 8 ||
        seen.has(item.step) ||
        !Number.isSafeInteger(item.at) ||
        item.at <= 0 ||
        !["scanned", "reviewed"].includes(item.phase)
      )
        return null;
      seen.add(item.step);
    }
    return value.steps;
  } catch {
    return null;
  }
}
export function stepCategories(step: QuickSetupStepId): string[] {
  if (step === 1) return ["system", "resources"];
  if (step === 2 || step === 3) return ["ssh"];
  if (step === 4) return ["ssh", "security"];
  if (step === 5) return ["docker", "essentials"];
  if (step === 6 || step === 7) return ["essentials"];
  return ["system", "ssh", "security", "docker", "essentials", "resources"];
}
export function stepItems(draft: QuickSetupDraft) {
  return resolveQuickSetupPlan(draft).items.filter((item) => {
    const category = quickSetupCatalogEntry(item.id)?.category;
    if (draft.step === 5)
      return category === "application" || category === "engine";
    if (draft.step === 6)
      return category === "editor" || category === "utility";
    if (draft.step === 7) return category === "runtime";
    return draft.step === 8;
  });
}
export function freshSetupSnapshot(
  snapshot: ConfigurationSnapshot | undefined,
  profileId: string,
  connectionId: string | null | undefined,
  now: number,
) {
  return Boolean(
    snapshot &&
      connectionId &&
      snapshot.profileId === profileId &&
      snapshot.connectionId === connectionId &&
      snapshot.observedAt <= now &&
      now - snapshot.observedAt < 300_000,
  );
}

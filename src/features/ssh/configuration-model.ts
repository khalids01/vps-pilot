export type EvidenceState = "ready" | "partial" | "unavailable";
export interface ConfigurationEvidence {
  id: string;
  title: string;
  state: EvidenceState;
  values: Record<string, string>;
  message: string | null;
}
export interface ConfigurationSnapshot {
  profileId: string;
  connectionId: string;
  observedAt: number;
  snapshotId: string;
  sections: ConfigurationEvidence[];
}
export interface ConfigurationReviewItem {
  id: string;
  title: string;
  evidenceState: EvidenceState;
  blockers: string[];
  nextStep: string;
}
export interface ConfigurationReview {
  id: string;
  profileId: string;
  connectionId: string;
  profileRevision: string;
  snapshotId: string;
  observedAt: number;
  expiresAt: number;
  canExecute: boolean;
  items: ConfigurationReviewItem[];
}
export interface ReviewContext {
  profileId: string;
  connectionId: string | null | undefined;
  profileRevision: string;
  snapshotId: string;
  selected: string[];
}
export type ReviewMatch = { ok: true } | { ok: false; reason: string };
export function reviewMatchesContext(
  review: ConfigurationReview,
  context: ReviewContext,
): ReviewMatch {
  if (review.canExecute !== false)
    return {
      ok: false,
      reason: "Review unexpectedly allows execution.",
    };
  if (
    review.profileId !== context.profileId ||
    !context.connectionId ||
    review.connectionId !== context.connectionId
  )
    return {
      ok: false,
      reason: "Review belongs to a different server or connection.",
    };
  if (review.profileRevision !== context.profileRevision)
    return { ok: false, reason: "Server profile changed after review." };
  if (review.snapshotId !== context.snapshotId)
    return {
      ok: false,
      reason: "Inspection evidence changed after review.",
    };
  const ids = review.items.map((item) => item.id);
  if (
    ids.length !== context.selected.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !context.selected.includes(id))
  )
    return {
      ok: false,
      reason: "Review categories do not match the current selection.",
    };
  return { ok: true };
}
export type ItemStatus = "configured" | "attention" | "unknown";
export function evidenceStatus(
  evidence: ConfigurationEvidence | undefined,
): ItemStatus {
  if (evidence?.state !== "ready") return "unknown";
  return evidence.values.attention === "true" ? "attention" : "configured";
}
export function configurationQueryKey(profileId: string, connectionId: string) {
  return ["configuration", profileId, connectionId] as const;
}

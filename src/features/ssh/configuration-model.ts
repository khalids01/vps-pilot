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
  sections: ConfigurationEvidence[];
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

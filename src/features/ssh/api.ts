import { useQuery } from "@tanstack/react-query";
import { invoke, isTauri } from "@tauri-apps/api/core";

export const desktopAvailable = isTauri();
export interface ServerProfile {
  id: string;
  revision: string;
  name: string;
  host: string;
  port: number;
  username: string;
}
export interface ConfigHost {
  alias: string;
  host: string;
  port: number;
  username: string;
  blockedReason: string | null;
}
export interface ProfileInput {
  id: string | null;
  name: string;
  host: string;
  port: number;
  username: string;
}
export interface HostKey {
  algorithm: string;
  fingerprint: string;
}
export interface Inspection {
  profileId: string;
  challengeId: string;
  status: "unknown" | "known" | "changed";
  observed: HostKey;
  previous: HostKey | null;
}
export interface ConnectionStatus {
  profileId: string;
  status: "connecting" | "connected" | "disconnected" | "failed";
  error: string | null;
}
export const profileQueryKey = ["ssh", "profiles"] as const;
export const statusQueryKey = ["ssh", "statuses"] as const;
export const sshApi = {
  profiles: () => invoke<ServerProfile[]>("ssh_profiles"),
  configHosts: () => invoke<ConfigHost[]>("ssh_config_hosts"),
  saveProfile: (input: ProfileInput) =>
    invoke<ServerProfile>("ssh_save_profile", { input }),
  deleteProfile: (profileId: string) =>
    invoke<void>("ssh_delete_profile", { profileId }),
  inspect: (profileId: string) =>
    invoke<Inspection>("ssh_inspect", { profileId }),
  trust: (profileId: string, challengeId: string) =>
    invoke<void>("ssh_trust", { profileId, challengeId }),
  connect: (profileId: string, challengeId: string, password: string) =>
    invoke<void>("ssh_connect", { profileId, challengeId, password }),
  disconnect: (profileId: string) =>
    invoke<void>("ssh_disconnect", { profileId }),
};
export function useServerProfiles() {
  return useQuery({
    queryKey: profileQueryKey,
    queryFn: sshApi.profiles,
    enabled: desktopAvailable,
    retry: false,
  });
}
export function useConnectionStatuses(enabled: boolean) {
  return useQuery({
    queryKey: statusQueryKey,
    queryFn: () => invoke<ConnectionStatus[]>("ssh_statuses"),
    enabled: desktopAvailable && enabled,
    refetchInterval: 2000,
    retry: false,
  });
}
export const remoteTabId = (id: string) => `remote:${id}`;
export const address = (profile: ServerProfile) =>
  `${profile.username}@${profile.host.includes(":") ? `[${profile.host}]` : profile.host}:${profile.port}`;
export const safeError = (error: unknown) =>
  typeof error === "string"
    ? error
    : "The desktop operation could not be completed. Try again.";

export function useConfigHosts(enabled: boolean) {
  return useQuery({
    queryKey: ["ssh", "config-hosts"],
    queryFn: sshApi.configHosts,
    enabled: desktopAvailable && enabled,
    retry: false,
    staleTime: 0,
  });
}

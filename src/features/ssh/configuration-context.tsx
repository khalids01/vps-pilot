import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import {
  createContext,
  type ReactNode,
  useContext,
  useRef,
  useState,
} from "react";
import { type ServerProfile, safeError } from "./api";
import { useCommandActivity } from "./command-activity";
import {
  type ConfigurationSnapshot,
  configurationQueryKey,
} from "./configuration-model";

interface ConfigurationContextValue {
  snapshot?: ConfigurationSnapshot;
  busy: boolean;
  error: string;
  stale: boolean;
  canInspect: boolean;
  inspect: () => void;
  selected: string[];
  select: (id: string, checked: boolean) => void;
}
const Context = createContext<ConfigurationContextValue | null>(null);
export function useConfiguration() {
  const context = useContext(Context);
  if (!context) throw Error("Configuration requires a server workspace.");
  return context;
}
export function ConfigurationProvider({
  profile,
  connected,
  connectionId,
  children,
}: {
  profile: ServerProfile;
  connected: boolean;
  connectionId?: string | null;
  children: ReactNode;
}) {
  const log = useCommandActivity();
  const previous = useRef<ConfigurationSnapshot | undefined>(undefined);
  const [selected, setSelected] = useState<string[]>([]);
  const query = useQuery({
    queryKey: configurationQueryKey(profile.id, connectionId ?? "disconnected"),
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 30 * 60 * 1000,
    retry: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      if (!connected || !connectionId)
        throw Error("Connect and refresh connection status before inspecting.");
      let activity: string | undefined;
      try {
        const command = await invoke<string>("ssh_configuration_describe");
        activity = log.begin("Configuration inspection", command);
        const result = await invoke<ConfigurationSnapshot>(
          "ssh_configuration_snapshot",
          { profileId: profile.id, connectionId },
        );
        if (
          result.profileId !== profile.id ||
          result.connectionId !== connectionId
        )
          throw Error("Connection changed. Evidence was discarded.");
        log.update(activity, {
          status: "completed",
          ended: Date.now(),
          message:
            "Read-only inspection completed. Partial evidence is labeled.",
          output: result.sections
            .map((section) => `${section.title}: ${section.state}`)
            .join("\n"),
          code: 0,
        });
        return result;
      } catch (error) {
        if (activity)
          log.update(activity, {
            status: "failed",
            ended: Date.now(),
            message: safeError(error),
            code: null,
          });
        throw error;
      }
    },
  });
  if (query.data) previous.current = query.data;
  const snapshot = query.data ?? previous.current;
  return (
    <Context.Provider
      value={{
        snapshot,
        busy: query.isFetching,
        error: query.error ? safeError(query.error) : "",
        stale: Boolean(
          snapshot && (!connected || snapshot.connectionId !== connectionId),
        ),
        canInspect: connected && Boolean(connectionId),
        inspect: () => {
          if (connected && connectionId && !query.isFetching)
            void query.refetch({ cancelRefetch: false });
        },
        selected,
        select: (id, checked) =>
          setSelected((old) =>
            checked
              ? [...new Set([...old, id])].slice(0, 8)
              : old.filter((value) => value !== id),
          ),
      }}
    >
      {children}
    </Context.Provider>
  );
}

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
  connectionId?: string | null;
  busy: boolean;
  error: string;
  stale: boolean;
  canInspect: boolean;
  inspect: () => void;
  cancel: () => void;
  canceling: boolean;
  notice: string;
  selected: string[];
  select: (id: string, checked: boolean) => void;
}
interface InspectionRequest {
  profileId: string;
  connectionId: string;
  operationId: string;
  canceled: boolean;
  cancellation?: Promise<void>;
}
class InspectionCanceled extends Error {}
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
  const active = useRef<InspectionRequest | undefined>(undefined);
  const [running, setRunning] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [notice, setNotice] = useState("");
  const [cancelError, setCancelError] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  function cancelRequest(request = active.current) {
    if (!request || active.current !== request || request.cancellation) return;
    setCanceling(true);
    setCancelError("");
    request.cancellation = invoke<void>("ssh_configuration_cancel", {
      profileId: request.profileId,
      connectionId: request.connectionId,
      operationId: request.operationId,
    })
      .then(() => {
        request.canceled = true;
      })
      .catch((error) => {
        setCancelError(`Could not cancel inspection: ${safeError(error)}`);
        request.cancellation = undefined;
        setCanceling(false);
      });
  }
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
      if (active.current) throw Error("An inspection is already running.");
      const request: InspectionRequest = {
        profileId: profile.id,
        connectionId,
        operationId: crypto.randomUUID(),
        canceled: false,
      };
      active.current = request;
      setRunning(true);
      setNotice("");
      setCancelError("");
      let activity: string | undefined;
      try {
        const command = await invoke<string>("ssh_configuration_describe");
        activity = log.begin("Configuration inspection", command, {
          cancel: () => cancelRequest(request),
        });
        if (request.cancellation) await request.cancellation;
        if (request.canceled) throw new InspectionCanceled();
        const result = await invoke<ConfigurationSnapshot>(
          "ssh_configuration_snapshot",
          {
            profileId: profile.id,
            connectionId,
            operationId: request.operationId,
          },
        );
        if (request.cancellation) await request.cancellation;
        if (request.canceled) throw new InspectionCanceled();
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
          summary: result.sections.slice(0, 8).map((section) => ({
            title: section.title,
            state: section.state,
          })),
          code: 0,
        });
        return result;
      } catch (error) {
        if (request.cancellation) await request.cancellation;
        if (request.canceled) {
          const message = previous.current
            ? "Inspection canceled. Previous evidence was retained."
            : "Inspection canceled. No snapshot was collected.";
          setNotice(message);
          if (activity)
            log.update(activity, {
              status: "cancelled",
              ended: Date.now(),
              message,
              code: null,
            });
          throw new InspectionCanceled(message);
        }
        if (activity)
          log.update(activity, {
            status: "failed",
            ended: Date.now(),
            message: safeError(error),
            code: null,
          });
        throw error;
      } finally {
        if (active.current === request) active.current = undefined;
        setRunning(false);
        setCanceling(false);
      }
    },
  });
  if (query.data) previous.current = query.data;
  const snapshot = query.data ?? previous.current;
  return (
    <Context.Provider
      value={{
        snapshot,
        connectionId,
        busy: running || query.isFetching,
        canceling,
        notice,
        cancel: () => cancelRequest(),
        error:
          cancelError ||
          (query.error && !(query.error instanceof InspectionCanceled)
            ? safeError(query.error)
            : ""),
        stale: Boolean(
          snapshot && (!connected || snapshot.connectionId !== connectionId),
        ),
        canInspect: connected && Boolean(connectionId),
        inspect: () => {
          if (connected && connectionId && !query.isFetching && !active.current)
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

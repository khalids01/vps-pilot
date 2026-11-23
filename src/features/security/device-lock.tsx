import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/ui/password-input";
import { safeError } from "@/features/ssh/api";
import { DeviceLockedContext, useDeviceLocked } from "./lock-context";

interface Status {
  enabled: boolean;
  locked: boolean;
  available: boolean;
  appPasswordSet?: boolean;
  passwordRequired?: boolean;
  accountName?: string | null;
  unavailableReason?: string | null;
}
function useDevicePassword(clearOnLock = false) {
  const [password, setPassword] = useState("");
  useEffect(() => {
    const clear = () => {
      if (document.visibilityState !== "visible") setPassword("");
    };
    const blur = () => setPassword("");
    document.addEventListener("visibilitychange", clear);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("visibilitychange", clear);
      window.removeEventListener("blur", blur);
    };
  }, []);
  useEffect(() => {
    if (clearOnLock) setPassword("");
  }, [clearOnLock]);
  return [password, setPassword] as const;
}
function LoginPassword({
  id,
  label,
  placeholder = "Enter password",
  value,
  onChange,
  disabled,
  newPassword = false,
}: {
  id: string;
  label: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  newPassword?: boolean;
}) {
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <PasswordInput
        id={id}
        placeholder={placeholder}
        autoComplete={newPassword ? "new-password" : "current-password"}
        maxLength={4096}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
const passwordLabel = (status: Status) =>
  status.appPasswordSet ? "Password" : "PC login password";
export function DeviceLock({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(false);
  const [password, setPassword] = useDevicePassword();
  const refresh = useCallback(
    () =>
      invoke<Status>("app_security_status")
        .then(setStatus)
        .catch(() => {
          setStatus(null);
          setError("Cannot check device lock. Restart VPS Pilot to retry.");
        }),
    [],
  );
  useEffect(() => {
    if (!isTauri()) return;
    void refresh();
    const unlisten = listen("device-lock", () =>
      setStatus((current) => (current ? { ...current, locked: true } : null)),
    ).catch(() => () => {});
    const timer = setInterval(() => void refresh(), 1000);
    let last = 0;
    const activity = () => {
      if (Date.now() - last > 10000) {
        last = Date.now();
        void invoke("app_security_activity").catch(() => {});
      }
    };
    window.addEventListener("pointerdown", activity);
    window.addEventListener("keydown", activity);
    return () => {
      void unlisten.then((dispose) => dispose()).catch(() => {});
      clearInterval(timer);
      window.removeEventListener("pointerdown", activity);
      window.removeEventListener("keydown", activity);
    };
  }, [refresh]);
  useEffect(() => {
    if (status && !status.locked) setOpened(true);
  }, [status]);
  if (!isTauri()) return children;
  const locked = !status || status.locked;
  return (
    <>
      <div className={locked ? "hidden" : "contents"} inert={locked}>
        <DeviceLockedContext.Provider value={locked}>
          {opened ? children : null}
        </DeviceLockedContext.Provider>
      </div>
      {locked && (
        <>
          <style>
            {
              "body > :not(#root) { visibility: hidden !important; pointer-events: none !important; }"
            }
          </style>
          <main
            aria-label="Unlock VPS Pilot"
            className="flex min-h-dvh items-center justify-center bg-background p-5 text-foreground"
          >
            <div className="w-full max-w-[380px] rounded-xl border border-border/80 bg-card p-7 shadow-xl shadow-black/15 sm:p-8">
              <h1 className="mb-7 text-xl font-semibold tracking-tight">
                Unlock VPS Pilot
              </h1>
              <form
                className="space-y-5"
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (busy) return;
                  const credential = password;
                  setPassword("");
                  setBusy(true);
                  setError("");
                  try {
                    await invoke("app_security_unlock", {
                      password: credential || null,
                    });
                    await refresh();
                  } catch (error) {
                    setError(safeError(error));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {status?.passwordRequired && (
                  <LoginPassword
                    id="device-unlock-password"
                    label={passwordLabel(status)}
                    placeholder={
                      status.appPasswordSet
                        ? "Enter your app password"
                        : "Enter your PC login password"
                    }
                    value={password}
                    onChange={setPassword}
                    disabled={busy}
                  />
                )}
                {error && (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                )}
                <div className="flex gap-3 pt-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    className="flex-1"
                    disabled={busy}
                    onClick={() => {
                      setPassword("");
                      setError("");
                      document
                        .getElementById("device-unlock-password")
                        ?.focus();
                    }}
                  >
                    Clear
                  </Button>
                  <Button
                    type="submit"
                    size="lg"
                    className="flex-1"
                    disabled={busy || !status}
                  >
                    {busy ? "Unlocking…" : "Unlock"}
                  </Button>
                </div>
              </form>
            </div>
          </main>
        </>
      )}
    </>
  );
}
export function DeviceSecuritySettings() {
  const locked = useDeviceLocked();
  const [password, setPassword] = useDevicePassword(locked);
  const [newPassword, setNewPassword] = useDevicePassword(locked);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<"toggle" | "password" | null>(null);
  const refresh = () => invoke<Status>("app_security_status").then(setStatus);
  useEffect(() => {
    if (isTauri())
      void invoke<Status>("app_security_status")
        .then(setStatus)
        .catch(() => setError("Security settings are unavailable."));
  }, []);
  useEffect(() => {
    if (locked) {
      setForm(null);
      setError("");
      setNotice("");
    }
  }, [locked]);
  const openForm = (next: "toggle" | "password") => {
    setPassword("");
    setNewPassword("");
    setError("");
    setNotice("");
    setForm((old) => (old === next ? null : next));
  };
  const needsCurrent =
    form === "toggle"
      ? status?.passwordRequired
      : status?.appPasswordSet || (status?.enabled && status.passwordRequired);
  return (
    <section
      aria-labelledby="security-heading"
      className="border-b border-border/70 py-6"
    >
      <div className="mb-5 flex items-center justify-between">
        <h2 id="security-heading" className="text-sm font-semibold">
          Security
        </h2>
        <span className="text-xs text-muted-foreground">
          {status?.enabled ? "Lock on" : "Lock off"}
        </span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium">App lock</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Lock on startup and after 5 minutes of inactivity.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {status?.enabled && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={async () => {
                try {
                  await invoke("app_security_lock");
                } catch (error) {
                  setError(safeError(error));
                }
              }}
            >
              Lock now
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!status || busy || (!status.available && !status.enabled)}
            onClick={() => openForm("toggle")}
          >
            {status?.enabled ? "Disable lock" : "Enable lock"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!status || busy}
            onClick={() => openForm("password")}
          >
            {status?.appPasswordSet ? "Change password" : "Set password"}
          </Button>
        </div>
      </div>
      {form && (
        <form
          className="mt-5 space-y-4 rounded-lg border bg-muted/15 p-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy || !status) return;
            const current = password;
            const next = newPassword;
            setPassword("");
            setNewPassword("");
            setBusy(true);
            setError("");
            setNotice("");
            try {
              if (form === "password")
                await invoke("app_security_change_password", {
                  oldPassword: current || null,
                  newPassword: next,
                });
              else
                await invoke("app_security_enable", {
                  enabled: !status.enabled,
                  password: current || null,
                });
              await refresh();
              setForm(null);
              setNotice(
                form === "password"
                  ? "Password updated."
                  : status.enabled
                    ? "App lock disabled."
                    : "App lock enabled.",
              );
            } catch (error) {
              setError(safeError(error));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div
            className={
              form === "password" && needsCurrent
                ? "grid gap-4 sm:grid-cols-2"
                : "max-w-sm space-y-4"
            }
          >
            {needsCurrent && (
              <LoginPassword
                id="device-settings-password"
                label={
                  status?.appPasswordSet
                    ? "Current password"
                    : "PC login password"
                }
                placeholder={
                  status?.appPasswordSet
                    ? "Enter current password"
                    : "Enter PC login password"
                }
                value={password}
                onChange={setPassword}
                disabled={busy}
              />
            )}
            {form === "password" && (
              <LoginPassword
                id="device-new-password"
                label="New app password"
                placeholder="At least 8 characters"
                value={newPassword}
                onChange={setNewPassword}
                disabled={busy}
                newPassword
              />
            )}
          </div>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              {busy
                ? "Saving…"
                : form === "password"
                  ? "Save password"
                  : status?.enabled
                    ? "Disable lock"
                    : "Enable lock"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setForm(null);
                setPassword("");
                setNewPassword("");
                setError("");
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {notice && (
        <p role="status" className="mt-3 text-xs text-muted-foreground">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {form === "toggle" && status?.unavailableReason && (
        <p className="mt-3 text-xs text-muted-foreground">
          {status.unavailableReason}
        </p>
      )}
    </section>
  );
}

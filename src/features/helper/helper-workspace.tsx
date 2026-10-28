import {
  ArrowDownToLine,
  ArrowUpCircle,
  Copy,
  FileTerminal,
  HardDrive,
  Plug,
  ShieldCheck,
  Trash2,
  Unplug,
} from "lucide-react";
import { useState } from "react";
import { ActionReview } from "@/components/action-review";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { SampleServer } from "@/features/workspace/fixtures";
import type { HelperScenario } from "@/features/workspace/preferences";

type HelperAction = "install" | "update" | "uninstall";
const scenarios: { value: HelperScenario; label: string }[] = [
  { value: "not-installed", label: "Not installed" },
  { value: "installed", label: "Installed sample" },
  { value: "update", label: "Update available" },
];
const preserved = [
  "Deployed applications and their data",
  "Docker containers, volumes, and mounted storage",
  "Proxy configuration and TLS certificates",
  "Your SSH access and firewall rules",
];
const reviews = {
  install: {
    title: "Review helper installation",
    purpose:
      "Add the optional server companion only when a feature needs it. Communication would use the existing authenticated SSH connection, with no public listener.",
    changes: [
      "Verify the supported Linux version, architecture, artifact authenticity, and helper protocol compatibility.",
      "Review the exact executable path, permissions, and any helper-owned runtime files before installation.",
      "Generate and save an exact manual removal command locally after verified installation.",
    ],
    blockedReason:
      "No helper release or installation plan exists yet. Verified paths, exact commands, and compatibility checks are required before installation can be enabled.",
    disabledLabel: "Install unavailable in preview",
  },
  update: {
    title: "Review helper update",
    purpose:
      "Replace only the verified helper installation. Updating requires explicit confirmation and a supported recovery path.",
    changes: [
      "Verify the new release and desktop/helper compatibility before replacing anything.",
      "Review the current and proposed versions, owned file paths, and any interruption to helper-dependent monitoring.",
      "Keep a verified previous helper version for recovery, and refresh locally saved removal instructions if paths change.",
    ],
    blockedReason:
      "Versions shown are sample labels. A signed or otherwise authenticated release, ownership checks, exact commands, and a tested recovery path are required before updating.",
    disabledLabel: "Update unavailable in preview",
  },
  uninstall: {
    title: "Review helper removal",
    purpose:
      "Remove only the helper and verified resources it owns. Keep the server's applications and existing deployment intact.",
    changes: [
      "Show the exact helper executable, process, runtime files, and service entries to remove; refuse ambiguous ownership.",
      "Stop only helper-owned activity and remove its executable last so interrupted removal can be retried safely.",
      "Mark the helper as removed on the desktop. SSH terminals remain available; helper-dependent features show what is missing.",
    ],
    blockedReason:
      "The preview has no verified installation manifest or removal commands. Exact owned resources and any required per-command sudo approvals must be available before removal.",
    disabledLabel: "Remove unavailable in preview",
  },
} satisfies Record<
  HelperAction,
  {
    title: string;
    purpose: string;
    changes: string[];
    blockedReason: string;
    disabledLabel: string;
  }
>;

export function HelperWorkspace({
  server,
  scenario,
  onScenarioChange,
}: {
  server: SampleServer;
  scenario: HelperScenario;
  onScenarioChange: (scenario: HelperScenario) => void;
}) {
  const [action, setAction] = useState<HelperAction | null>(null);
  const installed = scenario !== "not-installed";
  const selectedScenario = scenarios.find((item) => item.value === scenario);
  return (
    <section
      aria-label={`${server.name} helper management`}
      className="space-y-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed px-4 py-3">
        <div>
          <p className="text-xs font-medium">Sample helper state</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Explore the lifecycle screens without changing a server.
          </p>
        </div>
        <Select
          value={scenario}
          onValueChange={(value) => {
            if (scenarios.some((item) => item.value === value))
              onScenarioChange(value as HelperScenario);
          }}
        >
          <SelectTrigger aria-label={`Sample helper state for ${server.name}`}>
            <SelectValue>{selectedScenario?.label}</SelectValue>
          </SelectTrigger>
          <SelectContent align="end" alignItemWithTrigger={false}>
            {scenarios.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {!server.available && (
        <div className="flex items-start gap-3 rounded-lg border bg-muted/40 p-4">
          <Unplug
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div>
            <h2 className="text-sm font-medium">Server disconnected</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Showing saved sample information. Live helper status is unknown.
              Installation, updates, and desktop removal need a verified
              connection; saved manual removal instructions would remain
              available offline.
            </p>
          </div>
        </div>
      )}
      <div className="rounded-xl border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="rounded-lg bg-primary/10 p-2.5 text-primary">
              <Plug className="size-5" aria-hidden="true" />
            </span>
            <div>
              <h2 className="text-base font-medium">VPS Pilot helper</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {server.name} ·{" "}
                {installed
                  ? "Installed state is illustrative"
                  : "Optional server companion"}
              </p>
            </div>
          </div>
          <span className="rounded-md bg-secondary px-2 py-1 text-xs text-secondary-foreground">
            {selectedScenario?.label}
          </span>
        </div>
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          {installed
            ? "The helper would provide structured server information and monitoring through SSH. It does not own your applications or replace the tools already running on this VPS."
            : "SSH will handle connections and terminal sessions. If a feature needs a helper, review its installation here. No public ports or permanently privileged daemon are planned."}
        </p>
        {installed && (
          <dl className="mt-5 grid gap-4 border-t pt-4 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">Version</dt>
              <dd className="mt-1 text-sm">
                sample-1{" "}
                <span className="text-xs text-muted-foreground">
                  (illustrative)
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Transport</dt>
              <dd className="mt-1 text-sm">Existing SSH connection</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Privilege</dt>
              <dd className="mt-1 text-sm">Per-command approval</dd>
            </div>
          </dl>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          {!installed ? (
            <Button variant="outline" onClick={() => setAction("install")}>
              <ArrowDownToLine aria-hidden="true" />
              Preview installation
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => setAction("update")}>
                <ArrowUpCircle aria-hidden="true" />
                Preview update
              </Button>
              <Button
                variant="destructive"
                onClick={() => setAction("uninstall")}
              >
                <Trash2 aria-hidden="true" />
                Preview removal
              </Button>
            </>
          )}
        </div>
      </div>
      {scenario === "update" && (
        <div className="rounded-lg border bg-primary/5 p-4">
          <h2 className="text-sm font-medium">Update available · sample-2</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Sample version labels demonstrate the update review. Updates require
            confirmation; they will never silently replace an existing helper.
          </p>
        </div>
      )}
      <section
        className="rounded-xl border bg-card/60 p-5"
        aria-labelledby={`manual-removal-${server.id}`}
      >
        <div className="flex items-center gap-2">
          <FileTerminal className="size-4 text-primary" aria-hidden="true" />
          <h2
            id={`manual-removal-${server.id}`}
            className="text-sm font-medium"
          >
            Remove directly over SSH
          </h2>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          After a verified installation, VPS Pilot will give you an exact
          removal command and save it locally. You can run it on the VPS without
          the desktop application.
        </p>
        <div className="mt-4 rounded-lg border bg-background p-4">
          <p className="text-xs text-muted-foreground">
            Command format preview · not executable
          </p>
          <code className="mt-2 block break-all text-xs">
            sudo &lt;verified-helper-path&gt; uninstall
          </code>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            disabled
            aria-describedby={`manual-command-status-${server.id}`}
          >
            <Copy aria-hidden="true" />
            Copy removal command
          </Button>
          <p
            id={`manual-command-status-${server.id}`}
            className="text-xs text-muted-foreground"
          >
            No verified command has been generated in this preview.
          </p>
        </div>
      </section>
      <div className="grid gap-4 sm:grid-cols-2">
        <section className="rounded-xl border p-5">
          <ShieldCheck
            className="mb-3 size-5 text-primary"
            aria-hidden="true"
          />
          <h2 className="text-sm font-medium">Your deployments stay intact</h2>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            Removal is limited to verified helper-owned resources. Applications,
            volumes, proxy configuration, certificates, and SSH access are
            preserved.
          </p>
        </section>
        <section className="rounded-xl border p-5">
          <HardDrive className="mb-3 size-5 text-primary" aria-hidden="true" />
          <h2 className="text-sm font-medium">Desktop-independent removal</h2>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            The VPS will contain its own uninstall capability. Repeat or
            interrupted removal must be safe; reconnecting must never replay a
            destructive action.
          </p>
        </section>
      </div>
      <Dialog
        open={action !== null}
        onOpenChange={(open) => {
          if (!open) setAction(null);
        }}
      >
        {action && (
          <ActionReview
            key={`${server.id}:${action}`}
            {...reviews[action]}
            serverName={server.name}
            address={server.address}
            preserved={preserved}
            confirmation={
              action === "install"
                ? undefined
                : `I reviewed the ${action === "update" ? "update" : "removal"} target: ${server.name} (${server.address}), and the resources that must be preserved.`
            }
          >
            <section>
              <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Exact command plan
              </h3>
              <p className="mt-2 rounded-lg border bg-background p-3 text-xs leading-relaxed text-muted-foreground">
                {server.available
                  ? "Pending release, compatibility, and ownership verification. No executable commands are generated by this sample."
                  : "Unavailable while disconnected. Reconnect and verify installation ownership before preparing any command."}
              </p>
            </section>
          </ActionReview>
        )}
      </Dialog>
    </section>
  );
}

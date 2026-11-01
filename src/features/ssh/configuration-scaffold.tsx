import {
  ConfigurationNotice,
  ConfigurationStatus,
} from "@/components/configuration-status";
import { Button } from "@/components/ui/button";
import type { ToolId } from "@/features/workspace/fixtures";
import type { ServerProfile } from "./api";

const categories: { name: string; description: string; tool?: ToolId }[] = [
  {
    name: "System",
    description: "Operating system, hostname, timezone and package updates.",
    tool: "overview",
  },
  {
    name: "Users and SSH",
    description:
      "Administrative users, authorized keys and authentication policy.",
    tool: "ssh-access",
  },
  {
    name: "Security",
    description: "UFW, Fail2ban and automatic security updates.",
    tool: "firewall",
  },
  {
    name: "Essential software",
    description: "Git, curl, certificates and common utilities.",
  },
  {
    name: "Docker",
    description: "Engine, Compose, installation source and existing workloads.",
    tool: "docker",
  },
  {
    name: "Resources",
    description: "Memory, swap, storage capacity and mount configuration.",
    tool: "overview",
  },
];

/** Phase-one navigation surface: no inspection or execution is triggered here. */
export function ConfigurationScaffold({
  tool,
  profile,
  connected,
  onNavigate,
}: {
  tool: "quick-setup" | "ssh-access";
  profile: ServerProfile;
  connected: boolean;
  onNavigate: (tool: ToolId) => void;
}) {
  const setup = tool === "quick-setup";
  return (
    <section
      aria-label={setup ? "Quick Setup" : "SSH Access"}
      className="space-y-6"
    >
      <header>
        <h1 className="text-xl font-semibold tracking-tight">
          {setup ? "Quick Setup" : "SSH Access"}
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          {setup
            ? "Review your server’s configuration and choose only the changes you need. Existing applications and settings should be preserved."
            : "Manage access with verified keys and a recovery path before changing authentication or listening ports."}
        </p>
      </header>
      <ConfigurationNotice
        title={connected ? "Detection is coming next" : "Server disconnected"}
      >
        {connected
          ? "This page has not inspected the server. Configuration detection and reviewed changes are being added in the next steps."
          : "Connect using the workspace connection control. No server configuration has been inspected here."}
      </ConfigurationNotice>
      {setup ? (
        <div className="divide-y border-y">
          {categories.map((category) => (
            <div
              key={category.name}
              className="flex flex-wrap items-center justify-between gap-4 py-4"
            >
              <div className="min-w-0 flex-1 basis-64">
                <h2 className="text-sm font-medium">{category.name}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {category.description}
                </p>
              </div>
              <ConfigurationStatus state="unknown" />
              {category.tool ? (
                <Button
                  variant="outline"
                  onClick={() => onNavigate(category.tool as ToolId)}
                >
                  {category.tool === "ssh-access"
                    ? "Open SSH Access"
                    : category.tool === "firewall"
                      ? "Open Firewall"
                      : category.tool === "docker"
                        ? "Open Docker"
                        : `Open Overview for ${category.name.toLowerCase()}`}
                </Button>
              ) : (
                <span className="text-xs text-muted-foreground">
                  Detection pending
                </span>
              )}
            </div>
          ))}
        </div>
      ) : (
        <>
          <section aria-label="Saved connection" className="space-y-3">
            <h2 className="text-sm font-medium">Saved connection</h2>
            <p className="text-sm text-muted-foreground">
              These are local profile settings, not the effective SSH server
              policy.
            </p>
            <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-3 text-sm">
              <dt className="text-muted-foreground">Host</dt>
              <dd className="break-all">{profile.host}</dd>
              <dt className="text-muted-foreground">User</dt>
              <dd className="break-all">{profile.username}</dd>
              <dt className="text-muted-foreground">Port</dt>
              <dd className="tabular-nums">{profile.port}</dd>
              <dt className="text-muted-foreground">Local key</dt>
              <dd className="break-all">
                {profile.identityFile || "Agent or default local keys"}
              </dd>
            </dl>
          </section>
          <section aria-label="SSH server policy" className="border-t pt-4">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-sm font-medium">SSH server policy</h2>
              <ConfigurationStatus state="unknown" />
            </div>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Password authentication, public-key authentication, root login,
              authorized keys and active listeners need effective server
              inspection. A saved key path does not prove that key login works.
            </p>
          </section>
        </>
      )}
    </section>
  );
}

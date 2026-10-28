import {
  ArrowRight,
  Container,
  Cpu,
  HardDrive,
  MemoryStick,
  Network,
  Plug,
  Unplug,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SampleServer, ToolId } from "./fixtures";
import type { HelperScenario } from "./preferences";

export function Overview({
  server,
  onNavigate,
  helperScenario,
}: {
  server: SampleServer;
  onNavigate: (tool: ToolId) => void;
  helperScenario: HelperScenario;
}) {
  if (!server.available) {
    return (
      <div className="flex min-h-72 flex-col items-center justify-center rounded-xl border border-dashed p-8 text-center">
        <Unplug
          className="mb-4 size-7 text-muted-foreground"
          aria-hidden="true"
        />
        <h2 className="text-lg font-medium">No server data available</h2>
        <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
          This sample demonstrates a disconnected workspace. Metrics and
          software inventory will appear after a real connection and discovery
          are implemented.
        </p>
      </div>
    );
  }
  const { metrics } = server;
  const cards = [
    {
      label: "CPU",
      value: `${metrics.cpu}%`,
      percent: metrics.cpu,
      detail: "Sample processor usage",
      icon: Cpu,
    },
    {
      label: "Memory",
      value: `${metrics.memoryUsed} / ${metrics.memoryTotal} GB`,
      percent: (metrics.memoryUsed / metrics.memoryTotal) * 100,
      detail: `${(metrics.memoryTotal - metrics.memoryUsed).toFixed(1)} GB available`,
      icon: MemoryStick,
    },
    {
      label: "Disk",
      value: `${metrics.diskUsed} / ${metrics.diskTotal} GB`,
      percent: (metrics.diskUsed / metrics.diskTotal) * 100,
      detail: `${metrics.diskTotal - metrics.diskUsed} GB available`,
      icon: HardDrive,
    },
  ];
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-3">
        {cards.map(({ label, value, percent, detail, icon: Icon }) => (
          <section
            key={label}
            aria-label={`${label} sample metric`}
            className="min-w-0 rounded-xl border bg-card p-5"
          >
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>{label}</span>
              <Icon className="size-4" aria-hidden="true" />
            </div>
            <p className="my-4 text-2xl font-medium tracking-tight tabular-nums xl:text-3xl">
              {value}
            </p>
            <div
              aria-hidden="true"
              className="mb-3 h-1 overflow-hidden rounded-full bg-secondary"
            >
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${percent}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">{detail}</p>
          </section>
        ))}
      </div>
      <section aria-labelledby={`software-${server.id}`} className="mt-8">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
          <h2 id={`software-${server.id}`} className="text-sm font-medium">
            Detected software{" "}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              Sample inventory
            </span>
          </h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onNavigate("software")}
          >
            View software <ArrowRight aria-hidden="true" />
          </Button>
        </div>
        <div className="divide-y rounded-xl border bg-card/60 px-5">
          {server.software.map((item) => {
            const Icon =
              item.tool === "docker"
                ? Container
                : item.tool === "proxy"
                  ? Network
                  : Plug;
            return (
              <div
                key={item.name}
                className="flex flex-wrap items-center justify-between gap-4 py-5"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="rounded-lg bg-secondary p-2.5 text-primary">
                    <Icon className="size-4" aria-hidden="true" />
                  </span>
                  <div>
                    <h3 className="text-sm font-medium">{item.name}</h3>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {item.tool === "helper" &&
                      helperScenario !== "not-installed"
                        ? "Sample helper · version sample-1"
                        : item.description}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-xs text-muted-foreground">
                    {item.tool === "helper"
                      ? helperScenario === "update"
                        ? "Update available"
                        : helperScenario === "installed"
                          ? "Installed sample"
                          : "Not installed"
                      : item.status}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onNavigate(item.tool)}
                  >
                    View
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useRef, useState } from "react";
import { sampleServers } from "@/features/workspace/fixtures";
import type { SessionKind } from "./layout";

// xterm expects resolved colors; canvas converts the shared OKLCH theme to RGB.
function terminalColors(element: HTMLElement) {
  const style = getComputedStyle(element);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d");
  function resolve(token: string) {
    if (!context) return "#80cfa8";
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = style.getPropertyValue(token).trim();
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
  }
  return {
    background: resolve("--background"),
    foreground: resolve("--foreground"),
    cursor: resolve("--primary"),
    selectionBackground: resolve("--accent"),
    green: resolve("--primary"),
    brightBlack: resolve("--muted-foreground"),
  };
}

export function SampleTerminalPanel({
  api,
  params,
}: IDockviewPanelProps<{ serverId: string; kind: SessionKind }>) {
  const host = useRef<HTMLDivElement>(null);
  const [title, setTitle] = useState(api.title);
  const server = sampleServers.find((item) => item.id === params.serverId);

  useEffect(() => {
    const listener = api.onDidTitleChange((event) => setTitle(event.title));
    return () => listener.dispose();
  }, [api]);

  useEffect(() => {
    if (!host.current || !server) return;
    const element = host.current;
    const terminal = new Terminal({
      disableStdin: true,
      screenReaderMode: true,
      cursorBlink: false,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      lineHeight: 1.35,
      scrollback: 500,
      convertEol: true,
      theme: terminalColors(element),
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    if (terminal.textarea)
      terminal.textarea.setAttribute(
        "aria-label",
        `${server.name} ${params.kind} sample output, read only`,
      );
    const fitVisible = () => {
      if (element.clientWidth > 0 && element.clientHeight > 0 && api.isVisible)
        fit.fit();
    };
    const observer = new ResizeObserver(fitVisible);
    observer.observe(element);
    const visible = api.onDidVisibilityChange(fitVisible);
    fitVisible();
    terminal.writeln(
      `\x1b[32m${server.name} / ${params.kind === "logs" ? "Application logs" : "Shell"}\x1b[0m`,
    );
    terminal.writeln("READ-ONLY SAMPLE · No SSH session or commands executed.");
    terminal.writeln("");
    if (params.kind === "logs") {
      terminal.writeln(`Sample application on ${server.name.toLowerCase()}`);
      terminal.writeln("\x1b[90m14:30:01\x1b[0m GET /health           200");
      terminal.writeln("\x1b[90m14:30:06\x1b[0m GET /api/projects     200");
      terminal.writeln("\x1b[90m14:30:12\x1b[0m Background job complete");
      terminal.writeln("\x1b[90m14:30:16\x1b[0m GET /health           200");
      terminal.writeln("");
      terminal.writeln("Sample ends here. Live streaming comes with SSH.");
    } else {
      terminal.writeln(`\x1b[32m${server.address}\x1b[0m:~$ docker ps`);
      terminal.writeln("");
      terminal.writeln("NAMES                 STATUS");
      terminal.writeln(
        server.id === "sample-production"
          ? "web                   Up 3 days\r\napi                   Up 3 days\r\npostgres              Up 12 days\r\nredis                 Up 12 days"
          : "staging-web           Up 2 hours\r\nstaging-api           Up 2 hours",
      );
      terminal.writeln("");
      terminal.writeln("Drag session tabs to group or split them.");
      terminal.writeln("Input is disabled in this preview.");
    }
    return () => {
      visible.dispose();
      observer.disconnect();
      terminal.dispose();
    };
  }, [api, params.kind, server]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-1 border-b px-3 py-1.5 text-[10px] text-muted-foreground">
        <span>
          {server?.name ?? "Unknown server"} · {title}
        </span>
        <span>Read-only sample</span>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden p-3">
        <div ref={host} className="h-full w-full" />
      </div>
    </div>
  );
}

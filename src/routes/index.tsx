import { createFileRoute } from "@tanstack/react-router";
import { Server, Terminal } from "lucide-react";
export const Route = createFileRoute("/")({ component: Home });
function Home() {
  return (
    <main className="flex h-dvh items-center justify-center overflow-auto p-8">
      <section className="w-full max-w-xl rounded-xl border bg-card p-8 shadow-xl">
        <div className="mb-6 flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Server className="size-6" aria-hidden="true" />
        </div>
        <p className="mb-2 text-xs font-medium uppercase tracking-widest text-primary">
          Your server workspace
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">VPS Pilot</h1>
        <p className="mt-3 leading-relaxed text-muted-foreground">
          A dedicated desktop workspace for managing your VPS servers.
        </p>
        <div className="mt-8 flex items-center gap-3 rounded-lg border bg-background/60 p-4 text-sm text-muted-foreground">
          <Terminal className="size-4 shrink-0" aria-hidden="true" />
          Project foundation ready. Server connections and management tools are
          coming next.
        </div>
      </section>
    </main>
  );
}

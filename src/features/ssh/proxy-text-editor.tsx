import { type ComponentProps, lazy, Suspense } from "react";

const Editor = lazy(() =>
  import("./text-editor").then((module) => ({ default: module.TextEditor })),
);
export function ProxyTextEditor(
  props: ComponentProps<typeof import("./text-editor").TextEditor>,
) {
  return (
    <Suspense
      fallback={
        <p className="p-3 text-xs text-muted-foreground">Loading editor…</p>
      }
    >
      <Editor {...props} />
    </Suspense>
  );
}

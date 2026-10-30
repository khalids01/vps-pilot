import { Tooltip as Primitive } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";

export function Tooltip({
  children,
  content,
}: {
  children: ReactElement;
  content: ReactNode;
}) {
  return (
    <Primitive.Provider delay={350}>
      <Primitive.Root>
        <Primitive.Trigger render={children} />
        <Primitive.Portal>
          <Primitive.Positioner sideOffset={6} className="z-[60]">
            <Primitive.Popup
              role="tooltip"
              className="max-w-64 rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
            >
              {content}
            </Primitive.Popup>
          </Primitive.Positioner>
        </Primitive.Portal>
      </Primitive.Root>
    </Primitive.Provider>
  );
}

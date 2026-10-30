import { Popover as Primitive } from "@base-ui/react/popover";
import { cn } from "cn";

export const Popover = Primitive.Root;
export const PopoverTrigger = Primitive.Trigger;
export const PopoverTitle = Primitive.Title;
export function PopoverContent({
  className,
  children,
  ...props
}: Primitive.Popup.Props) {
  return (
    <Primitive.Portal>
      <Primitive.Positioner
        side="bottom"
        align="end"
        sideOffset={8}
        className="z-50 max-w-[calc(100vw-1rem)]"
      >
        <Primitive.Popup
          {...props}
          className={cn(
            "max-h-[min(75dvh,42rem)] w-96 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border bg-popover p-4 text-popover-foreground shadow-xl outline-none",
            className,
          )}
        >
          {children}
        </Primitive.Popup>
      </Primitive.Positioner>
    </Primitive.Portal>
  );
}

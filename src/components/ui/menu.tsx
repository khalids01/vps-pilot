import { ContextMenu as ContextPrimitive } from "@base-ui/react/context-menu";
import { Menu as Primitive } from "@base-ui/react/menu";
import { cn } from "cn";
import { useLockableOpen } from "@/features/security/lock-context";

export const Menu: typeof Primitive.Root = (props) => {
  const lockable = useLockableOpen(props.open, props.defaultOpen);
  return (
    <Primitive.Root
      {...props}
      open={lockable.open}
      onOpenChange={(open, details) => {
        lockable.setOpen(open);
        props.onOpenChange?.(open, details);
      }}
    />
  );
};
export const MenuTrigger = Primitive.Trigger;
export const ContextMenu: typeof ContextPrimitive.Root = (props) => {
  const lockable = useLockableOpen(props.open, props.defaultOpen);
  return (
    <ContextPrimitive.Root
      {...props}
      open={lockable.open}
      onOpenChange={(open, details) => {
        lockable.setOpen(open);
        props.onOpenChange?.(open, details);
      }}
    />
  );
};
export const ContextMenuTrigger = ContextPrimitive.Trigger;
export function MenuItem({ className, ...props }: Primitive.Item.Props) {
  return (
    <Primitive.Item
      {...props}
      className={cn(
        "flex cursor-default items-center gap-2 rounded-md px-3 py-2 text-sm outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-40 [&_svg]:size-4",
        className,
      )}
    />
  );
}
const popupClass =
  "z-50 min-w-48 max-h-[70dvh] overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-xl outline-none";
export function MenuContent(props: Primitive.Popup.Props) {
  return (
    <Primitive.Portal>
      <Primitive.Positioner sideOffset={6} align="end" className="z-50">
        <Primitive.Popup {...props} className={popupClass} />
      </Primitive.Positioner>
    </Primitive.Portal>
  );
}
export function ContextMenuContent(props: Primitive.Popup.Props) {
  return (
    <ContextPrimitive.Portal>
      <ContextPrimitive.Positioner className="z-50">
        <ContextPrimitive.Popup {...props} className={popupClass} />
      </ContextPrimitive.Positioner>
    </ContextPrimitive.Portal>
  );
}

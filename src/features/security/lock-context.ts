import { createContext, useContext, useState } from "react";

export const DeviceLockedContext = createContext(false);
export const useDeviceLocked = () => useContext(DeviceLockedContext);

export function useLockableOpen(
  open: boolean | undefined,
  defaultOpen = false,
) {
  const locked = useDeviceLocked();
  const [internalOpen, setOpen] = useState(defaultOpen);
  return { open: locked ? false : (open ?? internalOpen), setOpen };
}

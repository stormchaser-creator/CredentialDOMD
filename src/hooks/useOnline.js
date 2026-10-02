import { useEffect, useState } from "react";

const onLineNow = () => typeof navigator === "undefined" || navigator?.onLine !== false;

/**
 * Whether the device says it is online, kept current by its online and
 * offline events. "Email it for me" is off while it is not (the share sheet
 * and Copy still work offline).
 */
export default function useOnline() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const w = globalThis.window;
    const changed = () => setTick((t) => t + 1);
    w?.addEventListener?.("online", changed);
    w?.addEventListener?.("offline", changed);
    return () => { w?.removeEventListener?.("online", changed); w?.removeEventListener?.("offline", changed); };
  }, []);
  return onLineNow();
}


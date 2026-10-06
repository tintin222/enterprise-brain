import { useCallback, useState } from "react";
import { readStorage, writeStorage } from "./storage.ts";

/**
 * A yes or no the viewer chose, such as a menu folded away, kept in this browser. `initial` decides
 * until they choose (for example: folded on a narrow screen).
 */
export function useStoredFlag(key: string, initial: () => boolean): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => {
    const stored = readStorage(key);
    return stored === null ? initial() : stored === "1";
  });
  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      writeStorage(key, next ? "1" : "0");
    },
    [key],
  );
  return [value, set];
}

/** True while the person types in a field, where a single-key shortcut must not fire. */
export function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName);
}

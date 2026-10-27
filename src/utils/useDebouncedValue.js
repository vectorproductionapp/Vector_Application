import { useEffect, useState } from "react";
import { SEARCH_DEBOUNCE_MS } from "../context/HeaderSearch";

/**
 * `value` once it has stopped changing for `delay` ms - for search boxes that
 * query the server, so a search runs once per pause instead of per keystroke.
 * An empty value applies at once, so clearing a search never waits.
 */
export default function useDebouncedValue(value, delay = SEARCH_DEBOUNCE_MS) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (!String(value ?? "").trim()) {
      setSettled(value);
      return undefined;
    }
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

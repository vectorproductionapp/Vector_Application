import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import SearchBar from "../components/SearchBar";

/**
 * Lets a page place its own search box in the global top header, next to the
 * profile menu, instead of inside its own toolbar.
 *
 * The header is rendered by the app shell while the state it edits lives in the
 * page, so the two are joined through this context rather than by prop-drilling
 * through the router. Only one page is mounted at a time, so a single slot is
 * enough; `owner` identifies the page holding the slot so the text resets when
 * the user moves between pages instead of leaking across them.
 */
const HeaderSearchContext = createContext(null);

export function HeaderSearchProvider({ children }) {
  const [slot, setSlot] = useState({ owner: null, placeholder: "", enabled: false });
  const [value, setValue] = useState("");
  const ownerRef = useRef(null);

  const register = useCallback((owner, placeholder, enabled) => {
    if (ownerRef.current !== owner) {
      ownerRef.current = owner;
      setValue("");
    }
    setSlot((prev) => (
      prev.owner === owner && prev.placeholder === placeholder && prev.enabled === enabled
        ? prev
        : { owner, placeholder, enabled }
    ));
  }, []);

  // Pages without a header search never register, so release the slot when this
  // provider's children change page. `register` is stable, so this only fires
  // on unmount.
  useEffect(() => () => {
    ownerRef.current = null;
    setSlot({ owner: null, placeholder: "", enabled: false });
    setValue("");
  }, []);

  return (
    <HeaderSearchContext.Provider value={{ slot, value, setValue, register }}>
      {children}
    </HeaderSearchContext.Provider>
  );
}

/**
 * Claim the header search slot for the calling page.
 *
 * @param {string} owner   Stable id for this page, e.g. "models".
 * @param {string} placeholder
 * @param {boolean} enabled  False to hide the box (e.g. while drilled into a PO).
 * @returns {[string, (value: string) => void]} The shared text and its setter.
 */
export function useHeaderSearch(owner, placeholder, enabled = true) {
  const context = useContext(HeaderSearchContext);
  const { register, setValue } = context;

  useEffect(() => {
    if (!enabled) {
      register(null, "", false);
      return undefined;
    }
    // `placeholder` is a dependency because a page can change it while it
    // keeps the same owner - PO Details swaps the wording as the user drills
    // from phases to POs to the line-item table.
    register(owner, placeholder, true);
    return () => register(null, "", false);
  }, [register, owner, enabled, placeholder]);

  return [enabled ? context.value : "", setValue];
}

/**
 * Renders the header search box. Place inside `.app-topbar-right`, before the
 * profile controls. Renders nothing unless a page has claimed the slot.
 */
export function HeaderSearchField() {
  const context = useContext(HeaderSearchContext);
  if (!context || !context.slot.enabled) return null;
  const { slot, value, setValue } = context;
  return (
    <div className="app-topbar-search">
      <SearchBar value={value} onChange={setValue} placeholder={slot.placeholder} />
    </div>
  );
}
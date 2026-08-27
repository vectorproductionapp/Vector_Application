import { useEffect, useRef, useState } from "react";
import "./GlobalApiLoader.css";

export default function GlobalApiLoader() {
  const [loading, setLoading] = useState(false);
  const hideFrame = useRef(null);

  useEffect(() => {
    const update = (event) => {
      const isLoading = Boolean(event.detail?.loading);
      if (hideFrame.current) cancelAnimationFrame(hideFrame.current);

      if (isLoading) {
        setLoading(true);
        return;
      }

      // Let React commit the fetched values and give the browser one frame to
      // paint them before the overlay is removed.
      hideFrame.current = requestAnimationFrame(() => {
        hideFrame.current = requestAnimationFrame(() => setLoading(false));
      });
    };
    window.addEventListener("vector:api-loading", update);
    return () => {
      window.removeEventListener("vector:api-loading", update);
      if (hideFrame.current) cancelAnimationFrame(hideFrame.current);
    };
  }, []);

  if (!loading) return null;
  return (
    <div className="global-api-loader" role="status" aria-live="polite" aria-label="Loading page data">
      <div className="global-api-loader-spinner" />
      <span>Loading data...</span>
    </div>
  );
}

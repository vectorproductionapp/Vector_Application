import React, { createContext, useContext, useEffect, useState, useCallback } from "react";

const ThemeContext = createContext({
  theme: "light",
  toggleTheme: () => {},
  setTheme: () => {},
});

const STORAGE_KEY = "pbd-theme";

function getInitialTheme() {
  if (typeof window === "undefined") return "light";
  const saved = window.localStorage.getItem(STORAGE_KEY);
  if (saved === "light" || saved === "dark") return saved;
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  return prefersDark ? "dark" : "light";
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(getInitialTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  const setTheme = useCallback((next) => setThemeState(next), []);
  const toggleTheme = useCallback(
    () => setThemeState((prev) => (prev === "light" ? "dark" : "light")),
    []
  );

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}

function readThemeColors() {
  if (typeof window === "undefined") return {};
  const styles = window.getComputedStyle(document.documentElement);
  const token = (name) => styles.getPropertyValue(name).trim() || `var(${name})`;
  return {
    accent: token("--accent"),
    accentHover: token("--accent-hover"),
    accentActive: token("--accent-active"),
    axis: token("--text-secondary"),
    grid: token("--border"),
    surface: token("--bg-surface"),
    cursor: token("--accent-soft-bg"),
    success: token("--success"),
    warning: token("--warning"),
    danger: token("--danger"),
    muted: token("--text-muted"),
    tooltip: {
      borderRadius: 12,
      border: `1px solid ${token("--border")}`,
      background: token("--bg-surface"),
      color: token("--text-primary"),
      boxShadow: token("--shadow-md"),
      fontSize: 12,
    },
    palette: [
      token("--chart-series-1"), token("--chart-series-2"),
      token("--chart-series-3"), token("--chart-series-4"),
      token("--chart-series-5"), token("--chart-series-6"),
    ],
  };
}

export function useThemeColors() {
  const { theme } = useTheme();
  const [colors, setColors] = useState(readThemeColors);

  useEffect(() => {
    const root = document.documentElement;
    const update = () => setColors(readThemeColors());
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    const frame = window.requestAnimationFrame(update);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [theme]);

  return colors;
}

export default ThemeContext;

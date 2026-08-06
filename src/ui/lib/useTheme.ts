import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light";

/**
 * useTheme — dark-first theme with localStorage persistence. Toggles the
 * `light`/`dark` class on <html> so Tailwind's class dark-mode + our CSS
 * overrides apply.
 */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === "undefined") return "dark";
    return (localStorage.getItem("factory-theme") as Theme) || "dark";
  });

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("light", theme === "light");
    root.classList.toggle("dark", theme === "dark");
    localStorage.setItem("factory-theme", theme);
  }, [theme]);

  const toggle = useCallback(
    () => setTheme((t) => (t === "dark" ? "light" : "dark")),
    [],
  );

  return { theme, toggle };
}

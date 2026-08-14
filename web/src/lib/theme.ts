export type AppTheme = "light" | "dark" | "system";
export type EffectiveTheme = "light" | "dark";

const THEME_STORAGE_KEY = "openboard-theme";

/**
 * Resolves the effective theme ("light" | "dark") from the user's preference ("light" | "dark" | "system").
 */
export function resolveEffectiveTheme(theme: AppTheme): EffectiveTheme {
  if (theme === "dark") return "dark";
  if (theme === "light") return "light";
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "light";
}

/**
 * Applies the given theme to the document root element (html) and stores the preference.
 */
export function applyTheme(theme: AppTheme): EffectiveTheme {
  const effective = resolveEffectiveTheme(theme);
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.classList.toggle("dark", effective === "dark");
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.style.colorScheme = effective;
  }
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Ignore storage errors in restricted sandbox environments
    }
  }
  return effective;
}

/**
 * Retrieves the stored theme preference from localStorage, falling back to "system".
 */
export function getStoredTheme(): AppTheme {
  if (typeof localStorage === "undefined") return "system";
  try {
    const val = localStorage.getItem(THEME_STORAGE_KEY);
    if (val === "light" || val === "dark" || val === "system") {
      return val;
    }
  } catch {
    // Ignore storage errors
  }
  return "system";
}

/**
 * Sets up a system color scheme listener that invokes the callback whenever the OS scheme changes.
 * Returns an unsubscribe cleanup function.
 */
export function setupSystemThemeListener(onSystemThemeChange: (dark: boolean) => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) {
    return () => {};
  }
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = (e: MediaQueryListEvent) => {
    onSystemThemeChange(e.matches);
  };
  if (media.addEventListener) {
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }
  // Fallback for older browsers
  media.addListener(handler);
  return () => media.removeListener(handler);
}

/**
 * Sets up a storage event listener that invokes callback when theme is changed in another browser tab.
 */
export function setupCrossTabThemeListener(onCrossTabThemeChange: (theme: AppTheme) => void): () => void {
  if (typeof window === "undefined" || !window.addEventListener) {
    return () => {};
  }
  const handler = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY && event.newValue) {
      const val = event.newValue;
      if (val === "light" || val === "dark" || val === "system") {
        onCrossTabThemeChange(val);
      }
    }
  };
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}

"use client";

import * as React from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "./button";

const STORAGE_KEY = "offline-theme";

export function ThemeProviderScript() {
  // Inline pre-hydration script to set .dark on <html> before paint.
  const code = `(function(){try{var k='${STORAGE_KEY}';var s=localStorage.getItem(k);var p=window.matchMedia('(prefers-color-scheme: dark)').matches;var d=s?s==='dark':p;var c=document.documentElement.classList;d?c.add('dark'):c.remove('dark');}catch(e){}})();`;
  return <script dangerouslySetInnerHTML={{ __html: code }} />;
}

export function ThemeToggle({ className }: { className?: string }) {
  const [mounted, setMounted] = React.useState(false);
  const [isDark, setIsDark] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
    setIsDark(document.documentElement.classList.contains("dark"));
  }, []);

  function toggle() {
    const next = !isDark;
    setIsDark(next);
    const c = document.documentElement.classList;
    if (next) c.add("dark");
    else c.remove("dark");
    try {
      localStorage.setItem(STORAGE_KEY, next ? "dark" : "light");
    } catch {}
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label="Toggle theme"
      onClick={toggle}
      className={className}
    >
      {mounted && isDark ? <Moon /> : <Sun />}
    </Button>
  );
}

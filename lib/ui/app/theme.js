/**
 * Theme management for WebMCP Vault UI.
 * Handles system preferences, local storage persistence, and toggle button state.
 */

const STORAGE_KEY = 'webmcp-vault-theme';

export function currentTheme() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') {
      return stored;
    }
  } catch (e) {}
  if (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

export function applyTheme(theme) {
  const normalized = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = normalized;
  const isDark = normalized === 'dark';
  const nextThemeAction = isDark ? 'Switch to light theme' : 'Switch to dark theme';
  const toggles = document.querySelectorAll('[data-theme-toggle]');
  toggles.forEach((btn) => {
    btn.setAttribute('title', nextThemeAction);
    btn.setAttribute('aria-label', nextThemeAction);
  });
}

export function setTheme(theme) {
  applyTheme(theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch (e) {}
}

export function initThemeToggle() {
  const initial = currentTheme();
  applyTheme(initial);

  document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const active = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
      const next = active === 'dark' ? 'light' : 'dark';
      setTheme(next);
    });
  });

  if (typeof matchMedia === 'function') {
    const mediaQuery = matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e) => {
      let stored = null;
      try {
        stored = localStorage.getItem(STORAGE_KEY);
      } catch (err) {}
      if (!stored) {
        applyTheme(e.matches ? 'dark' : 'light');
      }
    };
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', onChange);
    } else if (mediaQuery.addListener) {
      mediaQuery.addListener(onChange);
    }
  }
}

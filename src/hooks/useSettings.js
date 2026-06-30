import { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'subscribe-ai-settings';

// ─── Default configuration values ───
const DEFAULTS = {
  providerUrl: 'https://api.openai.com/v1',
  apiKey: '',
  modelName: 'gpt-4o',
  autoSave: true,
  notifications: false,
};

/**
 * Loads settings from localStorage. Returns merged defaults + stored values.
 */
function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...DEFAULTS, ...parsed };
    }
  } catch {
    // Corrupt storage — silently fall back to defaults. The UI surfaces
    // problems through the global LogContext at runtime; this early-load
    // path has no logger available yet.
  }
  return { ...DEFAULTS };
}

/**
 * Persists settings to localStorage.
 */
function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage full / unavailable — ignore silently at this layer.
  }
}

/**
 * Custom hook for managing application settings with localStorage persistence.
 *
 * Usage:
 *   const [settings, updateSetting, resetSettings] = useSettings();
 *   // settings.providerUrl, settings.apiKey, settings.modelName, etc.
 *   updateSetting('providerUrl', 'https://new-url.com');
 *   resetSettings(); // back to DEFAULTS
 */
export function useSettings() {
  const [settings, setSettings] = useState(loadSettings);
  const [loaded, setLoaded] = useState(false);

  // Mark as loaded after initial mount (for hydration safety)
  useEffect(() => {
    setLoaded(true);
  }, []);

  // Update a single setting field and persist immediately
  const updateSetting = useCallback((key, value) => {
    setSettings(prev => {
      const next = { ...prev, [key]: value };
      saveSettings(next);
      return next;
    });
  }, []);

  // Bulk-update multiple fields at once and persist
  const updateMany = useCallback((updates) => {
    setSettings(prev => {
      const next = { ...prev, ...updates };
      saveSettings(next);
      return next;
    });
  }, []);

  // Reset all settings to DEFAULTS and persist
  const resetSettings = useCallback(() => {
    saveSettings(DEFAULTS);
    setSettings({ ...DEFAULTS });
  }, []);

  // Read-only getter for a single setting
  const getSetting = useCallback((key) => {
    return settings[key];
  }, [settings]);

  return {
    settings,
    loaded,
    updateSetting,
    updateMany,
    resetSettings,
    getSetting,
  };
}

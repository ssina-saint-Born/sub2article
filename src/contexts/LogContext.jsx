import React, { createContext, useContext, useState, useCallback, useRef } from 'react';

const LogContext = createContext(null);

// ─── Maximum log entries to keep in memory (prevents unbounded growth) ───
const MAX_LOGS = 500;

/**
 * LogProvider wraps the app and provides a global `addLog` function.
 * Any component can call `useLog()` to get: { addLog, logs, clearLogs }
 */
export function LogProvider({ children }) {
  const [logs, setLogs] = useState(() => {
    // No need to persist logs across restarts — they are runtime only
    return [
      { id: genId(), type: 'info', message: 'SubScribe AI v1.0.0 initialized.', time: new Date() },
      { id: genId(), type: 'success', message: 'Application ready. Select a tab to begin.', time: new Date() },
    ];
  });

  const counterRef = useRef(0);

  const addLog = useCallback((type, message) => {
    const entry = { id: genId(counterRef), type, message, time: new Date() };
    setLogs(prev => {
      const next = [...prev, entry];
      // Trim oldest entries if we exceed the cap
      return next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next;
    });
  }, []);

  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  return (
    <LogContext.Provider value={{ logs, addLog, clearLogs }}>
      {children}
    </LogContext.Provider>
  );
}

/**
 * Hook for any component to access the global logging system.
 *
 * Usage:
 *   const { addLog } = useLog();
 *   addLog('success', 'Something worked!');
 *
 * Log types: 'info' | 'success' | 'warning' | 'error'
 */
export function useLog() {
  const ctx = useContext(LogContext);
  if (!ctx) {
    throw new Error('useLog() must be used inside <LogProvider>');
  }
  return ctx;
}

// ─── Internal helpers ───
function genId(counterRef) {
  const next = (counterRef?.current || 0) + 1;
  // Only persist the counter when a ref is provided (i.e. from addLog).
  // During the useState initializer, counterRef isn't created yet, so we
  // skip the write and still return a unique id.
  if (counterRef) counterRef.current = next;
  return `log-${Date.now()}-${next}`;
}

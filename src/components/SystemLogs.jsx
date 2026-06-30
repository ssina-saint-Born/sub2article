import React, { useEffect, useRef } from 'react';
import { useLog } from '../contexts/LogContext';

const typeStyles = {
  info: 'text-sky-400',
  success: 'text-emerald-400',
  warning: 'text-amber-400',
  error: 'text-red-400',
};

const typeLabels = {
  info: 'INF',
  success: 'OK ',
  warning: 'WRN',
  error: 'ERR',
};

function formatTime(date) {
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export default function SystemLogs({ isOpen, onToggle, onClear }) {
  const { logs } = useLog();
  const bottomRef = useRef(null);

  // Auto-scroll to newest log whenever logs change
  useEffect(() => {
    if (isOpen) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, isOpen]);

  return (
    <div
      className={`shrink-0 border-t border-surface-800/50 transition-all duration-300 ease-in-out ${
        isOpen ? 'h-48' : 'h-8'
      }`}
    >
      {/* ─── Header (always visible) ─── */}
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-1.5 bg-surface-900/60 hover:bg-surface-900/80 transition-colors"
      >
        <div className="flex items-center gap-2">
          <svg className="w-3.5 h-3.5 text-surface-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <span className="text-xs font-medium text-surface-400">
            System Console
          </span>
          {logs.length > 0 && (
            <span className="text-[10px] font-mono text-surface-600">
              ({logs.length} entries)
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {logs.length > 0 && (
            <span
              onClick={(e) => { e.stopPropagation(); onClear(); }}
              className="text-[10px] text-surface-500 hover:text-red-400 transition-colors cursor-pointer px-1"
            >
              Clear
            </span>
          )}
          <svg
            className={`w-3 h-3 text-surface-500 transition-transform duration-300 ${isOpen ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {/* ─── Log Content ─── */}
      {isOpen && (
        <div className="h-[calc(100%-32px)] overflow-y-auto bg-surface-950 px-4 py-2 font-mono text-[11px] leading-relaxed">
          {logs.length === 0 ? (
            <div className="text-surface-600 italic py-2">No logs to display.</div>
          ) : (
            logs.map((log) => (
              <div key={log.id} className="flex gap-2 animate-fade-in">
                <span className="text-surface-600 shrink-0">[{formatTime(log.time)}]</span>
                <span className={`${typeStyles[log.type]} shrink-0`}>[{typeLabels[log.type]}]</span>
                <span className="text-surface-300">{log.message}</span>
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}

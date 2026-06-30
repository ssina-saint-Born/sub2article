import React from 'react';

const icons = {
  subtitle: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
    </svg>
  ),
  ocr: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  ),
  settings: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  ),
  logs: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  ),
};

export default function Sidebar({ tabs, activeTab, onTabChange, logsOpen, onToggleLogs, logCount }) {
  return (
    <aside className="w-60 bg-surface-900/80 border-r border-surface-800/40 flex flex-col shrink-0">
      {/* ─── Navigation Items ─── */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        <div className="px-3 mb-4">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-surface-500">
            Workspace
          </p>
        </div>

        {tabs.map(tab => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 group
                ${isActive
                  ? 'bg-brand-600/15 text-brand-400 glow-sm'
                  : 'text-surface-400 hover:text-surface-200 hover:bg-surface-800/50'
                }
              `}
            >
              <span className={`transition-colors ${isActive ? 'text-brand-400' : 'text-surface-500 group-hover:text-surface-300'}`}>
                {icons[tab.icon]}
              </span>
              <span>{tab.label}</span>
              {isActive && (
                <span className="ml-auto w-1.5 h-1.5 rounded-full bg-brand-400 animate-pulse-slow" />
              )}
            </button>
          );
        })}
      </nav>

      {/* ─── Bottom: Logs Toggle ─── */}
      <div className="px-3 pb-4 space-y-2">
        <div className="border-t border-surface-800/40 pt-3">
          <button
            onClick={onToggleLogs}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200
              ${logsOpen
                ? 'bg-amber-500/10 text-amber-400'
                : 'text-surface-400 hover:text-surface-200 hover:bg-surface-800/50'
              }
            `}
          >
            <span className={logsOpen ? 'text-amber-400' : 'text-surface-500'}>
              {icons.logs}
            </span>
            <span>System Logs</span>
            {logCount > 0 && (
              <span className="ml-auto w-5 h-5 rounded-full bg-red-500/20 text-red-400 text-[10px] font-bold flex items-center justify-center">
                {logCount}
              </span>
            )}
          </button>
        </div>
      </div>
    </aside>
  );
}

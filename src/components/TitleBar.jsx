import React from 'react';

export default function TitleBar() {
  return (
    <div className="drag-region flex items-center justify-between h-10 px-4 bg-surface-950 border-b border-surface-800/50 shrink-0">
      {/* Left: App branding */}
      <div className="flex items-center gap-2 no-drag">
        <div className="w-5 h-5 rounded-md bg-gradient-to-br from-brand-500 to-purple-500 flex items-center justify-center">
          <span className="text-[10px] font-bold text-white">S</span>
        </div>
        <span className="text-xs font-semibold text-surface-300 tracking-wide">
          SubScribe AI
        </span>
        <span className="text-[10px] font-mono text-surface-600 ml-1">v1.0.0</span>
      </div>

      {/* Right: Window controls */}
      <div className="flex items-center no-drag">
        <button
          onClick={() => window.electronAPI?.window.minimize()}
          className="w-10 h-8 flex items-center justify-center hover:bg-surface-800/60 transition-colors rounded-l-lg"
        >
          <svg className="w-3.5 h-3.5 text-surface-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M20 12H4" />
          </svg>
        </button>
        <button
          onClick={() => window.electronAPI?.window.maximize()}
          className="w-10 h-8 flex items-center justify-center hover:bg-surface-800/60 transition-colors"
        >
          <svg className="w-3.5 h-3.5 text-surface-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
          </svg>
        </button>
        <button
          onClick={() => window.electronAPI?.window.close()}
          className="w-10 h-8 flex items-center justify-center hover:bg-red-500/80 transition-colors rounded-r-lg group"
        >
          <svg className="w-3.5 h-3.5 text-surface-400 group-hover:text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}

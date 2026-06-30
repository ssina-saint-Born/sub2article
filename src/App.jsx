import React, { useState, useCallback } from 'react';

// ─── Contexts ───
import { LogProvider, useLog } from './contexts/LogContext';

// ─── Components ───
import Sidebar from './components/Sidebar';
import TitleBar from './components/TitleBar';
import SubtitleProcessor from './components/tabs/SubtitleProcessor';
import ImageOCR from './components/tabs/ImageOCR';
import Settings from './components/tabs/Settings';
import SystemLogs from './components/SystemLogs';

const TABS = [
  { id: 'subtitle', label: 'Subtitle Processor', icon: 'subtitle' },
  { id: 'ocr', label: 'Image OCR Extractor', icon: 'ocr' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

/**
 * Inner shell — lives inside <LogProvider> so it can use useLog().
 * This is where all stateful layout logic lives.
 */
function AppShell() {
  const { logs, addLog, clearLogs } = useLog();
  const [activeTab, setActiveTab] = useState('subtitle');
  const [logsOpen, setLogsOpen] = useState(false);

  // ─── Tab switch with logging ───
  const handleTabChange = useCallback((tabId) => {
    setActiveTab(prev => {
      if (prev !== tabId) {
        const tab = TABS.find(t => t.id === tabId);
        if (tab) {
          addLog('info', `Switched to "${tab.label}" view.`);
        }
      }
      return tabId;
    });
  }, [addLog]);

  const renderTab = () => {
    switch (activeTab) {
      case 'subtitle':
        return <SubtitleProcessor />;
      case 'ocr':
        return <ImageOCR />;
      case 'settings':
        return <Settings />;
      default:
        return null;
    }
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-surface-950 overflow-hidden">
      {/* ─── Title Bar ─── */}
      <TitleBar />

      {/* ─── Main Content ─── */}
      <div className="flex flex-1 overflow-hidden">
        {/* ─── Sidebar ─── */}
        <Sidebar
          tabs={TABS}
          activeTab={activeTab}
          onTabChange={handleTabChange}
          logsOpen={logsOpen}
          onToggleLogs={() => setLogsOpen(prev => !prev)}
          logCount={logs.filter(l => l.type === 'error').length}
        />

        {/* ─── Main Panel ─── */}
        <main className="flex-1 flex flex-col overflow-hidden animate-fade-in">
          <div className="flex-1 overflow-y-auto p-6" key={activeTab}>
            {renderTab()}
          </div>

          {/* ─── System Logs Panel ─── */}
          <SystemLogs
            isOpen={logsOpen}
            onToggle={() => setLogsOpen(prev => !prev)}
            onClear={clearLogs}
          />
        </main>
      </div>
    </div>
  );
}

/**
 * Root component — wraps everything in <LogProvider>
 * so any child component anywhere in the tree can call useLog().
 */
export default function App() {
  return (
    <LogProvider>
      <AppShell />
    </LogProvider>
  );
}

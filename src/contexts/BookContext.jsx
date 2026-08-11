import React, { createContext, useContext, useState, useCallback } from 'react';

const BookContext = createContext(null);

/**
 * BookProvider holds the Book-to-Digital accumulator state.
 * It lives at the app root so that accumulated text, the page queue,
 * and the real File references survive tab switches (App remounts the
 * active tab on change, so state inside the tab component itself is lost).
 */
export function BookProvider({ children }) {
  const [pages, setPages] = useState([]);            // [{ id, file, dataUrl, name, size, status }]
  const [accumulatedText, setAccumulatedText] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  // ─── Text accumulation (انباشتگی متن): append, never overwrite ───
  // New extractions are glued onto the existing string with a blank line.
  const appendText = useCallback((text) => {
    setAccumulatedText(prev => (prev ? prev + '\n\n' + text : text));
  }, []);

  // ─── Per-page lifecycle: queued → processing → done/failed ───
  // Lets the page queue tiles reflect live OCR progress without the
  // component holding a parallel copy of the queue.
  const updatePageStatus = useCallback((id, status) => {
    setPages(prev => prev.map(p => (p.id === id ? { ...p, status } : p)));
  }, []);

  // ─── Clear Temporary Memory: wipe text + queue entirely ───
  const clearAll = useCallback(() => {
    setPages([]);
    setAccumulatedText('');
    setIsProcessing(false);
  }, []);

  return (
    <BookContext.Provider value={{
      pages, setPages,
      accumulatedText, appendText,
      isProcessing, setIsProcessing,
      dragActive, setDragActive,
      clearAll,
      updatePageStatus,
    }}>
      {children}
    </BookContext.Provider>
  );
}

/**
 * Access the shared Book-to-Digital accumulator state.
 * Must be used inside <BookProvider>.
 */
export function useBook() {
  const ctx = useContext(BookContext);
  if (!ctx) {
    throw new Error('useBook() must be used inside <BookProvider>');
  }
  return ctx;
}

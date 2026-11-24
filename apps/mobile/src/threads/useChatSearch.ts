import { useEffect, useState } from 'react';

import { chatController } from './chats';
import type { SearchResult } from './search-index';

const DEBOUNCE_MS = 200;

/**
 * Search over chats kept on this phone. While the screen is open, older messages of chats not
 * yet fully kept are filled in; leaving the screen stops that.
 */
export function useChatSearch(query: string): {
  results: SearchResult[];
  searched: boolean;
  filling: boolean;
} {
  'use no memo';
  const active = chatController();
  const [found, setFound] = useState<{ query: string; results: SearchResult[] }>();
  const [filling, setFilling] = useState(false);
  const [filled, setFilled] = useState(0);

  useEffect(() => {
    if (!active) return;
    const abort = new AbortController();
    void active
      .refreshList()
      .then(() =>
        active.fillSearch(abort.signal, (busy) => {
          if (abort.signal.aborted) return;
          setFilling(busy);
          // Run the query again once older messages are in.
          if (!busy) setFilled((n) => n + 1);
        }),
      )
      .catch(() => undefined);
    return () => abort.abort();
  }, [active]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!active || !trimmed) return;
    let current = true;
    const timer = setTimeout(() => {
      void active.searchChats(trimmed).then((results) => {
        if (current) setFound({ query: trimmed, results });
      });
    }, DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [active, query, filled]);

  // Results for an earlier query are not shown for a new one.
  const searched = found !== undefined && found.query === query.trim();
  return { results: searched ? found.results : [], searched, filling };
}

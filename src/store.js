import { useCallback, useEffect, useState } from 'react';

// Each book keeps its own localStorage entry (same keys as the earlier single-book apps,
// so existing places and bookmarks carry over). The shelf has one small entry of its own.
const bookKey = slug => `${slug}-reader:v2`;
const SHELF_KEY = 'bookshelf:v1';

export const BOOK_DEFAULTS = {
  last: null,      // { ch, block, mode, pct, at }
  pos: {},         // ch -> { block, mode, pct }
  read: {},        // ch -> true
  bookmarks: [],   // { id, ch, block, mode, note, text, at }
};
const PREF_DEFAULTS = { mode: 'original', size: 19, lamp: false, lastBook: null };

const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } };

export function useStore(slugs) {
  const [books, setBooks] = useState(() => Object.fromEntries(slugs.map(s => {
    const b = read(bookKey(s), {});
    return [s, { ...BOOK_DEFAULTS, ...b }];
  })));
  const [prefs, setPrefsState] = useState(() => {
    const shelf = read(SHELF_KEY, {});
    // Text size and lamp were stored per book before; take them from the most recent book.
    const recent = slugs.map(s => read(bookKey(s), null)).filter(b => b && b.prefs).sort((a, b) => (b.last?.at || 0) - (a.last?.at || 0))[0];
    return { ...PREF_DEFAULTS, size: recent?.prefs?.size ?? PREF_DEFAULTS.size, lamp: !!recent?.prefs?.lamp, ...shelf };
  });

  useEffect(() => { write(SHELF_KEY, prefs); }, [prefs]);
  useEffect(() => { for (const s of slugs) write(bookKey(s), books[s]); }, [books, slugs]);

  const setBook = useCallback((slug, fn) => setBooks(bs => ({ ...bs, [slug]: fn(bs[slug]) })), []);
  const setPrefs = useCallback(p => setPrefsState(x => ({ ...x, ...p })), []);
  return { books, setBook, prefs, setPrefs };
}

export const markRead = (b, ch) => (b.read[ch] ? b : { ...b, read: { ...b.read, [ch]: true } });

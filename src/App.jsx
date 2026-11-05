import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import shelf from './data/shelf.json';
import rawBooks from './data/books.js';
import { BOOK_DEFAULTS, markRead, useStore } from './store.js';

const APP_NAME = 'Divyansh Book Shelf';

const WORDS = ['One', 'Two', 'Three', 'Four', 'Five', 'Six'];
const HEADER = 64;
const SLUGS = shelf.books.map(b => b.slug);
const byId = Object.fromEntries(shelf.books.map(b => [b.slug, b]));
const minutes = w => Math.max(1, Math.round(w / 230));
const fmtDate = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

// Book text is bundled as a string per book and parsed the first time that book is opened.
const parsed = {};
const loadText = slug => (parsed[slug] ||= JSON.parse(rawBooks[slug]).chapters);

// Routes: #/  #/book/<slug>  #/read/<slug>/<chapter>[/b<paragraph>]  #/bookmarks
function parseHash() {
  let m;
  if ((m = location.hash.match(/^#\/read\/([^/]+)\/([^/]+)(?:\/b(\d+))?/)) && byId[m[1]]?.chapters[m[2]]) return { view: 'read', slug: m[1], ch: m[2], block: m[3] != null ? +m[3] : null };
  if ((m = location.hash.match(/^#\/book\/([^/]+)/)) && byId[m[1]]) return { view: 'book', slug: m[1] };
  if (location.hash === '#/bookmarks') return { view: 'bookmarks' };
  return { view: 'shelf' };
}
const go = (slug, ch, block) => { location.hash = `#/read/${slug}/${ch}${block != null ? '/b' + block : ''}`; };

export default function App() {
  const { books, setBook, prefs, setPrefs } = useStore(SLUGS);
  const [route, setRoute] = useState(parseHash);
  const [panel, setPanel] = useState(null); // 'bookmarks' | 'contents' | null

  useEffect(() => {
    const onHash = () => { setRoute(parseHash()); setPanel(null); };
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    document.documentElement.style.setProperty('--size', prefs.size + 'px');
    document.body.classList.toggle('lamp', prefs.lamp);
  }, [prefs.size, prefs.lamp]);
  useEffect(() => {
    const b = route.slug && byId[route.slug];
    document.documentElement.style.setProperty('--cloth', b ? b.cloth : '#3a3330');
    document.documentElement.style.setProperty('--cloth-dark', b ? b.clothDark : '#2a2522');
    document.title = route.view === 'read' ? b.chapters[route.ch].title : b ? b.title : APP_NAME;
    if (b) setPrefs({ lastBook: route.slug });
  }, [route, setPrefs]);

  const clearBlock = useCallback(() => setRoute(r => ({ ...r, block: null })), []);
  const openSpot = useCallback(spot => {
    const hasShort = loadText(spot.slug)[spot.ch].condensed != null;
    setPrefs({ mode: spot.mode === 'condensed' && hasShort ? 'condensed' : 'original' });
    setPanel(null);
    go(spot.slug, spot.ch, spot.block ?? 0);
    setRoute({ view: 'read', slug: spot.slug, ch: spot.ch, block: spot.block ?? 0 });
  }, [setPrefs]);

  const common = { books, setBook, prefs, setPrefs, openSpot, openPanel: setPanel };
  return (
    <>
      {route.view === 'read' && <Reader key={route.slug + '/' + route.ch} {...route} {...common} clearBlock={clearBlock} />}
      {route.view === 'book' && <Book slug={route.slug} {...common} />}
      {route.view === 'shelf' && <Shelf {...common} />}
      {route.view === 'bookmarks' && <Bookmarks {...common} />}
      {panel === 'bookmarks' && (
        <Sheet title="Bookmarks" onClose={() => setPanel(null)}>
          <BookmarkList books={books} setBook={setBook} onOpen={openSpot} />
        </Sheet>
      )}
      {panel === 'contents' && route.slug && (
        <Sheet title={byId[route.slug].title} onClose={() => setPanel(null)}>
          <Contents slug={route.slug} current={route.ch} state={books[route.slug]} />
        </Sheet>
      )}
    </>
  );
}

/* ---------------- Shelf ---------------- */

function Shelf({ books, prefs, openSpot }) {
  useEffect(() => { window.scrollTo(0, 0); }, []);
  const marks = SLUGS.reduce((n, s) => n + books[s].bookmarks.length, 0);
  return (
    <main className="shelf">
      <header className="shelf-head"><h1>{APP_NAME}</h1><Ornament /></header>
      <ul className="shelf-row">
        {shelf.books.map(b => {
          const st = books[b.slug];
          const done = b.order.filter(id => st.read[id]).length;
          const last = st.last && b.chapters[st.last.ch] ? st.last : null;
          return (
            <li key={b.slug} style={{ '--cloth': b.cloth, '--cloth-dark': b.clothDark }}>
              <a className="vol" href={`#/book/${b.slug}`}>
                <span className="cover">
                  <span className="cover-frame"><span className="cover-title">{b.title}</span><Ornament gilt /></span>
                </span>
              </a>
              <p className="vol-meta">{b.order.length} chapters{done ? `, ${done} finished` : ''}</p>
              {done > 0 && <Bar value={done / b.order.length} />}
              {last && !st.read[last.ch] && (
                <button type="button" className="vol-continue" onClick={() => openSpot({ slug: b.slug, ...last })}>
                  <span>Continue</span> {b.chapters[last.ch].num}. {b.chapters[last.ch].title}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {marks > 0 && <p className="shelf-marks"><a href="#/bookmarks"><RibbonIcon /> Bookmarks ({marks})</a></p>}
    </main>
  );
}

/* ---------------- Book ---------------- */

function Book({ slug, books, setBook, openSpot, openPanel }) {
  const b = byId[slug];
  const st = books[slug];
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { setConfirm(false); }, [slug]);
  const hasState = st.last || Object.keys(st.read).length || st.bookmarks.length;
  useEffect(() => { window.scrollTo(0, 0); }, [slug]);
  const done = b.order.filter(id => st.read[id]).length;
  const last = st.last && b.chapters[st.last.ch] ? st.last : null;
  return (
    <main className="library">
      <a className="back" href="#/"><BackIcon /> {APP_NAME}</a>
      <header className="lib-cover">
        <div className="lib-cover-frame">
          <h1>{b.title}</h1>
          <Ornament gilt />
          <p>{b.order.length} chapters · {b.parts.length} parts</p>
        </div>
      </header>
      {(done > 0 || last) && (
        <section className="lib-status">
          {done > 0 && <Bar value={done / b.order.length} />}
          {last && !st.read[last.ch] && (
            <button type="button" className="continue" onClick={() => openSpot({ slug, ...last })}>
              <span className="continue-label">Continue</span>
              <span className="continue-title">{b.chapters[last.ch].num}. {b.chapters[last.ch].title}</span>
              <span className="continue-page">{Math.round((last.pct || 0) * 100)}%{last.mode === 'condensed' ? ' · short' : ''}</span>
            </button>
          )}
        </section>
      )}
      {b.parts.map((part, pi) => (
        <section className="lib-part" key={part.title}>
          <p className="part-num">Part {WORDS[pi]}</p>
          <h2>{part.title}</h2>
          {part.desc && <p className="part-desc">{part.desc}</p>}
          <ol className="chapters">
            {part.chapters.map(id => {
              const c = b.chapters[id];
              const pos = st.pos[id];
              const marks = st.bookmarks.filter(m => m.ch === id).length;
              const started = pos && pos.pct > 0.02 && !st.read[id];
              return (
                <li key={id}>
                  <a href={`#/read/${slug}/${id}`} className={st.read[id] ? 'finished' : ''}
                    onClick={e => { if (started) { e.preventDefault(); openSpot({ slug, ch: id, ...pos }); } }}>
                    <span className="c-num">{c.num}</span>
                    <span className="c-main">
                      <span className="c-title">{c.title}</span>
                      <span className="c-meta">
                        <span>{st.read[id] ? 'Finished' : started ? `${Math.round(pos.pct * 100)}%` : `${minutes(c.words.original)} min${c.words.condensed ? ` · ${minutes(c.words.condensed)} short` : ''}`}</span>
                        {marks ? <span className="c-marks"><RibbonIcon /> {marks}</span> : null}
                      </span>
                      {started && <Bar value={pos.pct} thin />}
                    </span>
                  </a>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
      {st.bookmarks.length > 0 && <p className="shelf-marks"><button type="button" className="btn" onClick={() => openPanel('bookmarks')}><RibbonIcon /> Bookmarks ({st.bookmarks.length})</button></p>}
      {hasState ? (
        <p className="reset">
          {confirm ? (
            <>
              <span>Reset {b.title}?</span>
              <button type="button" className="btn primary" onClick={() => { setBook(slug, () => structuredClone(BOOK_DEFAULTS)); setConfirm(false); window.scrollTo(0, 0); }}>Reset</button>
              <button type="button" className="btn" onClick={() => setConfirm(false)}>Cancel</button>
            </>
          ) : <button type="button" className="btn quiet" onClick={() => setConfirm(true)}>Reset</button>}
        </p>
      ) : null}
    </main>
  );
}

/* ---------------- Reader ---------------- */

function Reader({ slug, ch, block, books, setBook, prefs, setPrefs, clearBlock, openPanel }) {
  const b = byId[slug];
  const state = books[slug];
  const text = useMemo(() => loadText(slug)[ch], [slug, ch]);
  const info = b.chapters[ch];
  const short = text.condensed != null;
  const mode = prefs.mode === 'condensed' && short ? 'condensed' : 'original';
  const bodyRef = useRef(null);
  const barRef = useRef(null);
  const keepPct = useRef(null);
  const jumped = useRef(false);
  const [here, setHere] = useState(null);
  const [marks, setMarks] = useState([]);
  const [adding, setAdding] = useState(null);
  const [showType, setShowType] = useState(false);
  const idx = b.order.indexOf(ch);
  const prev = idx > 0 ? b.order[idx - 1] : null;
  const next = idx < b.order.length - 1 ? b.order[idx + 1] : null;

  const scrollPct = () => { const h = document.documentElement.scrollHeight - window.innerHeight; return h > 0 ? Math.min(1, window.scrollY / h) : 1; };

  useLayoutEffect(() => {
    if (block != null) {
      const el = bodyRef.current?.children[block];
      if (el && block > 0) {
        const to = () => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - HEADER - 16);
        to(); setTimeout(to, 250);
        setHere(block);
      } else window.scrollTo(0, 0);
      history.replaceState(null, '', `#/read/${slug}/${ch}`);
      jumped.current = true;
      clearBlock();
    } else if (jumped.current) {
      jumped.current = false;
    } else if (keepPct.current != null) {
      window.scrollTo(0, keepPct.current * (document.documentElement.scrollHeight - window.innerHeight));
      keepPct.current = null;
    } else window.scrollTo(0, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [block, mode]);

  const switchMode = m => { if (m !== mode) { keepPct.current = scrollPct(); setPrefs({ mode: m }); } };
  const topBlock = useCallback(() => {
    const kids = bodyRef.current ? [...bodyRef.current.children] : [];
    const i = kids.findIndex(k => k.getBoundingClientRect().bottom > HEADER + 8);
    return i < 0 ? 0 : i;
  }, []);

  useEffect(() => {
    let t = null;
    const save = () => {
      const spot = { block: topBlock(), mode, pct: scrollPct() };
      const atEnd = window.scrollY > 80 && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 60;
      setBook(slug, s => { let n = { ...s, last: { ch, ...spot, at: Date.now() }, pos: { ...s.pos, [ch]: spot } }; if (atEnd) n = markRead(n, ch); return n; });
    };
    const onScroll = () => { if (barRef.current) barRef.current.style.width = `${scrollPct() * 100}%`; clearTimeout(t); t = setTimeout(save, 300); };
    onScroll();
    addEventListener('scroll', onScroll, { passive: true });
    return () => { clearTimeout(t); removeEventListener('scroll', onScroll); };
  }, [slug, ch, mode, setBook, topBlock]);

  useLayoutEffect(() => {
    const place = () => {
      const kids = bodyRef.current ? [...bodyRef.current.children] : [];
      setMarks(state.bookmarks.filter(m => m.ch === ch && m.mode === mode && kids[m.block]).map(m => ({ id: m.id, top: kids[m.block].offsetTop, note: m.note })));
    };
    place();
    const ro = new ResizeObserver(place);
    if (bodyRef.current) ro.observe(bodyRef.current);
    return () => ro.disconnect();
  }, [state.bookmarks, ch, mode]);

  useEffect(() => {
    const onKey = e => {
      if (e.target.closest('input, textarea, [role="dialog"]') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowRight' && next) go(slug, next);
      if (e.key === 'ArrowLeft' && prev) go(slug, prev);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [slug, next, prev]);

  const marked = state.bookmarks.some(m => m.ch === ch);
  const saveBookmark = note => {
    const t = snippet(bodyRef.current?.children[adding]);
    setBook(slug, s => ({ ...s, bookmarks: [...s.bookmarks, { id: Date.now(), ch, block: adding, mode, note: note.trim(), text: t, at: Date.now() }] }));
    setHere(null); setAdding(null);
  };
  const finish = () => setBook(slug, s => markRead(s, ch));

  return (
    <div className="reader">
      <header className="bar">
        <a className="icon-btn" href={`#/book/${slug}`} aria-label={b.title}><BackIcon /></a>
        <button type="button" className="bar-title" onClick={() => openPanel('contents')} aria-label="Contents">
          <span className="bar-num">{info.num}</span><span className="bar-name">{info.title}</span>
        </button>
        <div className="seg" role="group" aria-label="Version">
          <button type="button" aria-pressed={mode === 'original'} onClick={() => switchMode('original')}>Full</button>
          <button type="button" aria-pressed={mode === 'condensed'} disabled={!short} onClick={() => switchMode('condensed')}>Short</button>
        </div>
        <button type="button" className={`icon-btn ${marked ? 'on' : ''}`} aria-label="Bookmark" onClick={() => setAdding(a => (a == null ? topBlock() : null))}><RibbonIcon filled={marked} /></button>
        <button type="button" className="icon-btn" aria-label="Bookmarks" onClick={() => openPanel('bookmarks')}><ListIcon /></button>
        <button type="button" className="icon-btn" aria-label="Text" aria-expanded={showType} onClick={() => setShowType(v => !v)}>Aa</button>
        <div className="scroll-track" aria-hidden="true"><span ref={barRef} /></div>
      </header>

      {showType && (
        <div className="pop type-pop" role="dialog" aria-label="Text">
          <button type="button" className="btn" onClick={() => setPrefs({ size: Math.max(14, prefs.size - 1) })}>Smaller</button>
          <button type="button" className="btn" onClick={() => setPrefs({ size: Math.min(28, prefs.size + 1) })}>Larger</button>
          <button type="button" className="btn" aria-pressed={prefs.lamp} onClick={() => setPrefs({ lamp: !prefs.lamp })}>{prefs.lamp ? 'Day' : 'Night'}</button>
        </div>
      )}
      {adding != null && <AddBookmark onSave={saveBookmark} onCancel={() => setAdding(null)} where={snippet(bodyRef.current?.children[adding])} />}

      <main className="page">
        <header className="opener">
          <p className="ch-num">Chapter {info.num}</p>
          <h1>{info.title}</h1>
          {info.sub && <p className="ch-sub">{info.sub}</p>}
          <Ornament />
          {text.cover && <figure className="frontis"><img src={text.cover} alt="" /></figure>}
          <p className="read-time">{minutes(info.words[mode] || info.words.original)} min{mode === 'condensed' ? ' · short' : short ? ` · ${minutes(info.words.condensed)} short` : ''}</p>
        </header>
        <div className="body-wrap">
          {marks.map(m => <button type="button" key={m.id} className="mark" style={{ top: m.top }} title={m.note || ''} aria-label="Bookmark" onClick={() => openPanel('bookmarks')}><RibbonIcon filled /></button>)}
          {here != null && bodyRef.current?.children[here] && (
            <span className="here" style={{ top: bodyRef.current.children[here].offsetTop, height: bodyRef.current.children[here].offsetHeight }} onAnimationEnd={() => setHere(null)} />
          )}
          <div className="prose" ref={bodyRef} dangerouslySetInnerHTML={{ __html: text[mode] }} />
        </div>
        <nav className="pager" aria-label="Chapters">
          {prev ? <a className="prev" href={`#/read/${slug}/${prev}`}><small>Previous</small><span>{b.chapters[prev].title}</span></a> : <span />}
          {next
            ? <a className="next" href={`#/read/${slug}/${next}`} onClick={finish}><small>Next</small><span>{b.chapters[next].title}</span></a>
            : <a className="next" href={`#/book/${slug}`} onClick={finish}><small>End</small><span>{b.title}</span></a>}
        </nav>
      </main>
    </div>
  );
}

const snippet = el => { const t = (el?.textContent || '').replace(/\s+/g, ' ').trim(); return t.length > 70 ? t.slice(0, 67) + '...' : t; };

function AddBookmark({ where, onSave, onCancel }) {
  const [note, setNote] = useState('');
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <form className="pop add-pop" role="dialog" aria-label="Bookmark" onSubmit={e => { e.preventDefault(); onSave(note); }}>
      {where && <p className="add-where">“{where}”</p>}
      <input ref={ref} value={note} onChange={e => setNote(e.target.value)} placeholder="Note" aria-label="Note" onKeyDown={e => e.key === 'Escape' && onCancel()} />
      <div className="pop-actions">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn primary">Save</button>
      </div>
    </form>
  );
}

/* ---------------- Panels ---------------- */

function Sheet({ title, onClose, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const onKey = e => e.key === 'Escape' && onClose();
    addEventListener('keydown', onKey);
    ref.current?.querySelector('a, button:not([data-close])')?.focus({ preventScroll: true });
    ref.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'center' });
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="sheet" role="dialog" aria-label={title} ref={ref}>
        <div className="sheet-head"><h2>{title}</h2><button type="button" className="icon-btn" data-close aria-label="Close" onClick={onClose}>×</button></div>
        {children}
      </aside>
    </>
  );
}

function Contents({ slug, current, state }) {
  const b = byId[slug];
  return (
    <div className="toc">
      <p className="toc-part"><a href="#/">{APP_NAME}</a> · <a href={`#/book/${slug}`}>{b.title}</a></p>
      {b.parts.map((p, pi) => (
        <section key={p.title}>
          <p className="toc-part">Part {WORDS[pi]} · {p.title}</p>
          <ol className="page-list">
            {p.chapters.map(id => (
              <li key={id}>
                <a href={`#/read/${slug}/${id}`} aria-current={id === current ? 'true' : 'false'} className={state.read[id] ? 'read' : ''}>
                  <span className="pl-n">{b.chapters[id].num}</span><span className="pl-t">{b.chapters[id].title}</span>{state.read[id] && <span className="pl-done">✓</span>}
                </a>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function Bookmarks({ books, setBook, openSpot }) {
  useEffect(() => { window.scrollTo(0, 0); }, []);
  return (
    <main className="library">
      <a className="back" href="#/"><BackIcon /> {APP_NAME}</a>
      <h1 className="plain-h1">Bookmarks</h1>
      <BookmarkList books={books} setBook={setBook} onOpen={openSpot} grouped />
    </main>
  );
}

function BookmarkList({ books, setBook, onOpen, grouped }) {
  const list = shelf.books.flatMap(b => [...books[b.slug].bookmarks].sort((x, y) => b.order.indexOf(x.ch) - b.order.indexOf(y.ch) || x.block - y.block).map(m => ({ ...m, slug: b.slug })));
  if (!list.length) return null;
  let lastSlug = null;
  return (
    <ul className="bm-list">
      {list.map(m => {
        const b = byId[m.slug], c = b.chapters[m.ch];
        if (!c) return null;
        const head = m.slug !== lastSlug && shelf.books.length > 1; lastSlug = m.slug;
        return (
          <li key={m.id} className={head ? 'bm-first' : ''}>
            {head && <p className="bm-book">{b.title}</p>}
            <div className="bm-row">
              <button type="button" className="bm-open" onClick={() => onOpen(m)}>
                <span className="bm-ch">{c.num}. {c.title}</span>
                {m.text && <span className="bm-page">“{m.text}”</span>}
                {m.note && <span className="bm-note">{m.note}</span>}
                <span className="bm-meta">{fmtDate(m.at)}{m.mode === 'condensed' ? ' · short' : ''}</span>
              </button>
              <button type="button" className="icon-btn bm-del" aria-label="Delete" onClick={() => setBook(m.slug, s => ({ ...s, bookmarks: s.bookmarks.filter(x => x.id !== m.id) }))}>×</button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/* ---------------- Bits ---------------- */

function Bar({ value, thin }) { return <span className={`bar-track ${thin ? 'thin' : ''}`} aria-hidden="true"><span style={{ width: `${Math.round(value * 100)}%` }} /></span>; }
function Ornament({ gilt }) {
  return (
    <svg className={`orn ${gilt ? 'gilt' : ''}`} viewBox="0 0 120 14" aria-hidden="true">
      <path d="M2 7h44M74 7h44" stroke="currentColor" strokeWidth=".8" />
      <path d="M60 1.5 66 7l-6 5.5L54 7z" fill="none" stroke="currentColor" strokeWidth=".9" />
      <circle cx="60" cy="7" r="1.6" fill="currentColor" /><circle cx="49" cy="7" r="1.1" fill="currentColor" /><circle cx="71" cy="7" r="1.1" fill="currentColor" />
    </svg>
  );
}
function RibbonIcon({ filled }) { return <svg viewBox="0 0 20 20" aria-hidden="true" className="ico"><path d="M5 2.5h10v15l-5-4-5 4z" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>; }
function BackIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true" className="ico"><path d="M12.5 4 6.5 10l6 6" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>; }
function ListIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true" className="ico"><path d="M7 5h10M7 10h10M7 15h10M3 5h1M3 10h1M3 15h1" stroke="currentColor" strokeWidth="1.5" /></svg>; }

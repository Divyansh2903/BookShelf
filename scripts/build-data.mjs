// Reads every book in books/ and writes:
//   src/data/shelf.json          light index: titles, colours, parts, chapter titles and lengths
//   src/data/books/<slug>.json   that book's full text (both versions, diagrams inlined)
// Books are bundled as strings and parsed only when opened, so the shelf opens instantly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOOKS = path.join(ROOT, 'books');
const OUT = path.join(ROOT, 'src', 'data');
fs.mkdirSync(path.join(OUT, 'books'), { recursive: true });

const md = new MarkdownIt({
  html: false, typographer: true,
  highlight(code, lang) {
    if (lang && hljs.getLanguage(lang)) { try { return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value; } catch {} }
    return '';
  },
});
const ROMAN = n => [[50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']].reduce((s, [v, r]) => { while (n >= v) { s += r; n -= v; } return s; }, '');
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const mime = f => ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' })[path.extname(f).toLowerCase()] || 'application/octet-stream';
const sections = t => { const p = t.split(/^<<<SECTION (\d+)>>>\s*$/m); const o = []; for (let i = 1; i < p.length; i += 2) o.push(p[i + 1].trim()); return o; };
const words = s => (s.replace(/```[\s\S]*?```/g, ' ').match(/\S+/g) || []).length;

const shelf = { books: [] };
// Shelf order: meta.order if set, then title.
const slugs = fs.readdirSync(BOOKS).filter(d => fs.existsSync(path.join(BOOKS, d, 'meta.json')))
  .map(d => ({ d, m: JSON.parse(fs.readFileSync(path.join(BOOKS, d, 'meta.json'), 'utf8')) }))
  .sort((a, b) => (a.m.order ?? 99) - (b.m.order ?? 99) || a.m.title.localeCompare(b.m.title)).map(x => x.d);
const allIds = {};
for (const slug of slugs) {
  const meta = JSON.parse(fs.readFileSync(path.join(BOOKS, slug, 'meta.json'), 'utf8'));
  for (const c of meta.chapters) allIds[c.id] = slug;
}

for (const slug of slugs) {
  const dir = path.join(BOOKS, slug);
  const C = p => path.join(dir, p);
  const meta = JSON.parse(fs.readFileSync(C('meta.json'), 'utf8'));
  const dataUri = rel => `data:${mime(rel)};base64,${fs.readFileSync(C('images/' + rel)).toString('base64')}`;
  const byStatus = Object.fromEntries(meta.chapters.filter(c => c.status).map(c => [c.status, c.id]));

  const render = (body, ch) => {
    let html = md.render(body.replace(/^\s*\{\{IMG:(\d+)\}\}\s*$/gm, '\n\n{{IMG:$1}}\n\n'));
    html = html.replace(/<p>\{\{IMG:(\d+)\}\}<\/p>/g, (all, n) => {
      const img = ch.imgs[+n - 1];
      if (!img) return '';
      const cap = img.alt && !/^(image|img)$/i.test(img.alt) ? `<figcaption>${esc(img.alt)}</figcaption>` : '';
      return `<figure class="plate"><img src="${dataUri(img.src)}" alt="${esc(img.alt || 'Diagram')}" loading="lazy">${cap}</figure>`;
    });
    // Cross-references open inside the shelf, even across books.
    const link = id => allIds[id] ? `href="#/read/${allIds[id]}/${id}" class="xref"` : null;
    html = html.replace(/href="(?:https?:\/\/(?:www\.)?vidya-bodha\.com)?\/articles\/([a-z0-9-]+)\/?"/g, (all, id) => link(id) || all);
    html = html.replace(/href="https:\/\/x\.com\/[^/"]+\/status\/(\d+)[^"]*"/g, (all, sid) => (byStatus[sid] && link(byStatus[sid])) || all);
    html = html.replace(/<a href="(https?:[^"]+)"/g, '<a href="$1" rel="noopener" target="_blank"');
    html = html.replace(/<p>\s*([↓↑→←⇩⇓|]{1,3})\s*<\/p>/g, '<p class="arrow">$1</p>');
    html = html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>');
    return html;
  };

  const chapters = {};
  const index = [];
  let n = 0;
  const missing = [];
  for (const part of meta.parts) {
    for (const id of part.chapters) {
      const ch = meta.chapters.find(c => c.id === id);
      n++;
      const orig = sections(fs.readFileSync(C(`original/${id}.md`), 'utf8'));
      const condF = C(`condensed/${id}.md`);
      let cond = fs.existsSync(condF) ? sections(fs.readFileSync(condF, 'utf8')) : null;
      if (!cond || cond.length !== orig.length) { missing.push(id); cond = null; }
      const origMd = orig.join('\n\n'), condMd = cond ? cond.join('\n\n') : null;
      const w = { original: words(origMd), condensed: condMd ? words(condMd) : null };
      chapters[id] = {
        id, num: ROMAN(n), title: ch.title, sub: ch.sub,
        cover: ch.cover ? dataUri(ch.cover) : null,
        original: render(origMd, ch),
        condensed: condMd ? render(condMd, ch) : null,
      };
      index.push({ id, num: ROMAN(n), title: ch.title, words: w, part: part.title });
    }
  }
  const parts = meta.parts.map(p => ({ title: p.title, desc: p.desc, chapters: p.chapters }));
  shelf.books.push({ slug, title: meta.title, cloth: meta.cloth, clothDark: meta.clothDark, parts, order: parts.flatMap(p => p.chapters), chapters: Object.fromEntries(index.map(c => [c.id, c])) });
  const file = path.join(OUT, 'books', `${slug}.json`);
  fs.writeFileSync(file, JSON.stringify({ slug, chapters }));
  console.log(`${slug}: ${n} chapters, ${(fs.statSync(file).size / 1048576).toFixed(1)} MB${missing.length ? `, no short version for ${missing.join(', ')}` : ''}`);
}
fs.writeFileSync(path.join(OUT, 'shelf.json'), JSON.stringify(shelf));
// The app imports each book as a raw string; this module lists them.
fs.writeFileSync(path.join(OUT, 'books.js'),
  slugs.map((s, i) => `import b${i} from './books/${s}.json?raw';`).join('\n') +
  `\nexport default { ${slugs.map((s, i) => `'${s}': b${i}`).join(', ')} };\n`);
console.log(`shelf: ${slugs.length} books`);

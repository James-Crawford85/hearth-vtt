// A small, safe Markdown renderer for journal entries. It builds DOM nodes
// directly (never innerHTML), so text written by players can't inject markup.
//
// Supported: # headings (1–4), paragraphs (single newlines become line
// breaks), **bold**, *italic* / _italic_, `code`, [text](url), ![alt](url),
// - / * bullet lists, 1. numbered lists, > quotes, --- rules, and two Hearth
// extras:
//   [[Name]] or [[Name|label]]   link to a journal entry (or actor) by name
//   [[/r 1d20 + 2]]              a button that rolls the formula

const INLINE = new RegExp([
  /\*\*(?<b>.+?)\*\*/,
  /`(?<code>[^`]+)`/,
  /\[\[(?<wiki>[^\]]+)\]\]/,
  /!\[(?<alt>[^\]]*)\]\((?<src>[^)\s]+)\)/,
  /\[(?<text>[^\]]+)\]\((?<href>[^)\s]+)\)/,
  /\*(?<i>[^*\s][^*]*?)\*/,
  /(?<![\w])_(?<u>[^_\s][^_]*?)_(?![\w])/,
].map((r) => r.source).join('|'));

/** Only web links and this server's own paths (not protocol-relative ones). */
export function safeUrl(url) {
  const u = String(url ?? '').trim();
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith('/') && !u.startsWith('//')) return u;
  return null;
}

function inline(text, opts, out) {
  let rest = text;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) { out.append(rest); break; }
    if (m.index) out.append(rest.slice(0, m.index));
    rest = rest.slice(m.index + m[0].length);
    const g = m.groups;
    if (g.b !== undefined) out.append(wrap('strong', g.b, opts));
    else if (g.i !== undefined) out.append(wrap('em', g.i, opts));
    else if (g.u !== undefined) out.append(wrap('em', g.u, opts));
    else if (g.code !== undefined) {
      const c = document.createElement('code');
      c.textContent = g.code;
      out.append(c);
    } else if (g.wiki !== undefined) out.append(wiki(g.wiki, opts));
    else if (g.src !== undefined) {
      const src = safeUrl(g.src);
      if (src) {
        const img = document.createElement('img');
        img.src = src;
        img.alt = g.alt;
        img.loading = 'lazy';
        out.append(img);
      } else out.append(m[0]);
    } else if (g.href !== undefined) {
      const href = safeUrl(g.href);
      if (href) {
        const a = document.createElement('a');
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        inline(g.text, opts, a);
        out.append(a);
      } else out.append(g.text);
    }
  }
}

function wrap(tag, text, opts) {
  const n = document.createElement(tag);
  inline(text, opts, n);
  return n;
}

function wiki(body, opts) {
  const roll = /^\/(?:r|roll)\s+(.+)$/i.exec(body.trim());
  if (roll) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'inline-roll';
    b.textContent = `🎲 ${roll[1]}`;
    b.title = `Roll ${roll[1]}`;
    b.addEventListener('click', () => opts.onRoll?.(roll[1]));
    return b;
  }
  const [name, label] = body.split('|').map((s) => s.trim());
  const a = document.createElement('a');
  a.href = '#';
  a.className = 'content-link';
  a.textContent = label || name;
  if (opts.resolves && !opts.resolves(name)) a.classList.add('broken');
  a.addEventListener('click', (e) => { e.preventDefault(); opts.onLink?.(name); });
  return a;
}

/**
 * Render Markdown to a DocumentFragment.
 * opts: { onLink(name), onRoll(formula), resolves(name) → bool }
 */
export function renderMarkdown(src, opts = {}) {
  const frag = document.createDocumentFragment();
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  let para = null, list = null, quote = null;
  const close = () => { para = null; list = null; quote = null; };

  for (const line of lines) {
    if (!line.trim()) { close(); continue; }
    let m;
    if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) {
      close();
      frag.append(wrap(`h${m[1].length + 1}`, m[2], opts)); // h2–h5: the entry title is the h1
    } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      close();
      frag.append(document.createElement('hr'));
    } else if ((m = /^\s*>\s?(.*)$/.exec(line))) {
      if (!quote) { close(); quote = document.createElement('blockquote'); frag.append(quote); }
      else quote.append(document.createElement('br'));
      inline(m[1], opts, quote);
    } else if ((m = /^\s*(?:([-*])|(\d+)[.)])\s+(.*)$/.exec(line))) {
      const tag = m[1] ? 'ul' : 'ol';
      if (!list || list.tagName.toLowerCase() !== tag) {
        close();
        list = document.createElement(tag);
        if (m[2] && m[2] !== '1') list.start = Number(m[2]);
        frag.append(list);
      }
      const li = document.createElement('li');
      inline(m[3], opts, li);
      list.append(li);
    } else {
      if (!para) { close(); para = document.createElement('p'); frag.append(para); }
      else para.append(document.createElement('br'));
      inline(line, opts, para);
    }
  }
  return frag;
}

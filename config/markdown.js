const MarkdownIt = require('markdown-it');
const sanitizeHtml = require('sanitize-html');

const markdown = new MarkdownIt({html: true, linkify: true, typographer: false});
markdown.linkify.set({fuzzyLink: false});

// Match the existing heading anchors and strikethrough markup.
markdown.core.ruler.push('heading_ids', state => {
  const counts = new Map();
  for (let i = 0; i < state.tokens.length; i++) {
    if (state.tokens[i].type !== 'heading_open') continue;
    const slug = state.tokens[i + 1].content.replace(/[^\w]/g, '').toLowerCase();
    const count = counts.get(slug) || 0;
    counts.set(slug, count + 1);
    state.tokens[i].attrSet('id', slug + (count ? `-${count}` : ''));
  }
});
markdown.renderer.rules.s_open = () => '<del>';
markdown.renderer.rules.s_close = () => '</del>';

// CommonMark consumes more backslash escapes than the previous renderer.
// Keep TeX spacing commands such as \; and \, for the existing MathJax loader.
markdown.inline.ruler.before('escape', 'legacy_backslash_escapes', (state, silent) => {
  const next = state.src[state.pos + 1];
  if (state.src[state.pos] !== '\\' || !next || next === '\n') return false;
  if (next === '&' || next === '<') {
    // Leave entities, HTML and autolinks to their own rules, retaining the slash.
    if (!silent) state.pending += '\\';
    state.pos++;
    return true;
  }
  if (/[\\`*_{}\[\]()>#+.!~=|:-]/.test(next)) return false;
  if (!silent) state.pending += '\\' + next;
  state.pos += 2;
  return true;
});

markdown.core.ruler.after('linkify', 'legacy_ellipsis', state => {
  for (const block of state.tokens) {
    let linkDepth = 0;
    for (const token of block.children || []) {
      if (token.type === 'link_open') linkDepth++;
      else if (token.type === 'link_close') linkDepth--;
      else if (token.type === 'text' && !linkDepth) token.content = token.content.replace(/\.\.\./g, '…');
    }
  }
});

// Preserve literal multiplication/identifiers such as a*b*c and a**b**c.
markdown.inline.ruler.before('emphasis', 'literal_mid_word_asterisks', (state, silent) => {
  const start = state.pos;
  if (state.src[start] !== '*' || !/\w/.test(state.src[start - 1] || '')) return false;
  let end = start;
  while (state.src[end] === '*') end++;
  if (!/\w/.test(state.src[end] || '')) return false;
  if (!silent) state.pending += state.src.slice(start, end);
  state.pos = end;
  return true;
});

const sanitizerOptions = {
  allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img', 'del', 'details', 'summary'],
  allowedAttributes: {
    '*': ['title'],
    code: ['class'],
    span: ['class'],
    a: ['href', 'name'],
    img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
    ...Object.fromEntries(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map(tag => [tag, ['id']])),
    ol: ['start'],
    td: ['colspan', 'rowspan', 'align', 'style'],
    th: ['colspan', 'rowspan', 'align', 'scope', 'style'],
    details: ['open'],
  },
  allowedClasses: {code: ['language-*'], span: ['tex2jax_ignore']},
  allowedStyles: {'*': {'text-align': [/^(left|right|center)$/]}},
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: {img: ['http', 'https']},
  nonTextTags: ['script', 'style', 'textarea', 'option', 'iframe', 'object', 'embed', 'svg', 'math'],
};

function sanitizeRenderedHtml(html) {
  return sanitizeHtml(html, sanitizerOptions);
}

function renderMarkdown(source) {
  return sanitizeRenderedHtml(markdown.render(source ?? ''));
}

module.exports = {renderMarkdown, sanitizeRenderedHtml};

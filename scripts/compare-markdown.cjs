const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {parseDocument} = require('htmlparser2');
const {renderMarkdown, sanitizeRenderedHtml} = require('../config/markdown');

const blockTags = new Set(['html', 'body', 'div', 'p', 'pre', 'blockquote', 'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

// Normalize serialization/insignificant block whitespace, not code whitespace,
// paragraph/list structure, inline spacing, link targets, or heading anchors.
function canonicalHtml(html) {
  function canonical(node, pre = false) {
    if (node.type === 'text') return pre ? node.data : node.data.replace(/[ \t\r\n]+/g, ' ');
    if (node.type === 'comment') return null;
    const name = node.name || 'root';
    const attrs = {...node.attribs};
    if (['td', 'th'].includes(name) && /^text-align:\s*(left|right|center);?$/.test(attrs.style || '')) {
      attrs.align = attrs.style.match(/left|right|center/)[0];
      delete attrs.style;
    }
    if (name === 'code' && /\blanguage-/.test(attrs.class || '')) {
      attrs.class = attrs.class.split(/\s+/).filter(c => c.startsWith('language-')).sort().join(' ');
    }
    let children = (node.children || []).map(child => canonical(child, pre || name === 'pre')).filter(c => c !== null);
    if (!pre && name !== 'pre' && (name === 'root' || blockTags.has(name))) {
      children = children.filter((c, i) => c !== ' ' ||
        (i > 0 && i < children.length - 1 && !blockTags.has(children[i - 1]?.[0]) && !blockTags.has(children[i + 1]?.[0])));
      if (typeof children[0] === 'string') children[0] = children[0].trimStart();
      const last = children.length - 1;
      if (typeof children[last] === 'string') children[last] = children[last].trimEnd();
    }
    return [name, Object.entries(attrs).sort(([a], [b]) => a.localeCompare(b)), children];
  }
  return JSON.stringify(canonical(parseDocument(html)));
}

function nodeText(node) {
  return node.type === 'text' ? node.data : (node.children || []).map(nodeText).join('');
}

function visibleText(html) {
  return nodeText(parseDocument(html)).replace(/[ \t\r\n]+/g, ' ').replace(/^ +| +$/g, '');
}

function bareWwwLinks(html) {
  const links = new Map();
  const walk = node => {
    if (node.name === 'a' && node.attribs.href) {
      const label = nodeText(node).trim();
      if (/^www\./i.test(label)) links.set(label, (links.get(label) || 0) + 1);
    }
    for (const child of node.children || []) walk(child);
  };
  walk(parseDocument(html));
  return links;
}

function compareCorpus(corpus, legacy) {
  if (!Array.isArray(corpus.problems) || !Array.isArray(corpus.skills)) throw Error('Expected problems and skills arrays.');
  const counts = {problems: corpus.problems.length, skills: corpus.skills.length,
    rendered: 0, passthrough: 0, identical: 0, formatting: 0, layout: 0, text: 0, sanitizerChanges: 0,
    bareWwwNoLongerLinked: {problems: 0, skills: 0, occurrences: 0}};
  const records = [], differences = [];
  for (const kind of ['problems', 'skills']) for (const row of corpus[kind]) {
    const source = (kind === 'problems' ? row.problemText : row.description) ?? '';
    if (typeof source !== 'string') throw Error('Content must be a string or null.');
    const record = {kind, id: row._id?.$oid ?? String(row._id), mimeType: row.mimeType,
      sourceSha256: createHash('sha256').update(source).digest('hex')};
    if (kind === 'problems' && row.mimeType !== 'markdown') {
      counts.passthrough++; record.status = 'passthrough'; records.push(record); continue;
    }
    counts.rendered++;
    const before = legacy.makeHtml(source) || '';
    const after = renderMarkdown(source);
    const oldWww = bareWwwLinks(before), newWww = bareWwwLinks(after);
    const lostWww = [...oldWww].reduce((sum, [label, count]) => sum + Math.max(0, count - (newWww.get(label) || 0)), 0);
    if (lostWww) {
      counts.bareWwwNoLongerLinked[kind]++;
      counts.bareWwwNoLongerLinked.occurrences += lostWww;
    }
    const sanitizedBefore = sanitizeRenderedHtml(before);
    const beforeCanonical = canonicalHtml(before);
    record.sanitizerChanged = beforeCanonical !== canonicalHtml(sanitizedBefore);
    if (record.sanitizerChanged) counts.sanitizerChanges++;
    record.status = before.trim() === after.trim() ? 'identical' :
      beforeCanonical === canonicalHtml(after) ? 'formatting' :
        visibleText(before) === visibleText(after) ? 'layout' : 'text';
    counts[record.status]++;
    records.push(record);
    if (record.status !== 'identical') differences.push({...record, source, before, after, sanitizedBefore});
  }
  return {counts, records, differences};
}

if (require.main === module) {
  const [input, output, legacyModule] = process.argv.slice(2);
  if (!input || !output || !legacyModule) {
    console.error('Usage: node scripts/compare-markdown.cjs input.json private-output.json /path/to/legacy/node_modules/showdown');
    process.exitCode = 1;
  } else {
    const Showdown = require(path.resolve(legacyModule));
    const legacy = new Showdown.Converter({literalMidWordUnderscores: true, literalMidWordAsterisks: true,
      simplifiedAutoLink: true, strikethrough: true, tables: true, ghCodeBlocks: true});
    const report = compareCorpus(JSON.parse(fs.readFileSync(input, 'utf8')), legacy);
    // Reports contain course text. Require a new explicit destination and keep it private.
    fs.writeFileSync(output, JSON.stringify(report, null, 2), {mode: 0o600, flag: 'wx'});
    console.log(JSON.stringify(report.counts, null, 2));
  }
}

module.exports = {canonicalHtml, compareCorpus};

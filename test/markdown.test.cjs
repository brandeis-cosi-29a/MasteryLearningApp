const test = require('node:test');
const assert = require('node:assert/strict');
const {parseDocument} = require('htmlparser2');
const {renderMarkdown, sanitizeRenderedHtml} = require('../config/markdown');
const {canonicalHtml, compareCorpus} = require('../scripts/compare-markdown.cjs');
const {fixture, serve} = require('./helpers/app.cjs');

test('Markdown retains course formatting, literal identifiers, links and heading anchors', () => {
  const html = renderMarkdown('# Alpha heading\n\n# Alpha heading\n\n' +
    '**bold** *italic* ~~removed~~ a_b_c a*b*c a**b**c ...\n\n' +
    'https://example.test [manual](/manual)\n\n' +
    '| Left | Right |\n| :--- | ---: |\n| one | two |\n\n' +
    '```python\nx = "<sample>"\n```');
  assert.match(html, /id="alphaheading"/);
  assert.match(html, /id="alphaheading-1"/);
  assert.match(html, /<strong>bold<\/strong> <em>italic<\/em> <del>removed<\/del> a_b_c a\*b\*c a\*\*b\*\*c …/);
  assert.match(html, /href="https:\/\/example.test"/);
  assert.match(html, /href="\/manual"/);
  assert.match(html, /<table>/);
  assert.match(html, /text-align:right/);
  assert.match(html, /class="language-python"/);
  assert.match(html, /x = &quot;&lt;sample&gt;&quot;|x = "&lt;sample&gt;"/);
  assert.equal(renderMarkdown(null), '');
  assert.equal(renderMarkdown(undefined), '');
});

test('legacy MathJax escapes and code contents survive rendering', () => {
  const source = String.raw`$\forall x \; P(x) \, Q(x)$ and $a_i + b_j$`;
  const html = renderMarkdown(source);
  assert(html.includes(source));
  // Existing content doubles Markdown backslashes when it needs a TeX brace.
  assert(renderMarkdown(String.raw`$A = \\{1,2\\}$`).includes(String.raw`$A = \{1,2\}$`));
  const code = renderMarkdown('```text\n... a*b*c \\;\n```');
  assert(code.includes('... a*b*c \\;'));
});

test('automatic links require URL schemes or email addresses; bare domains stay text', () => {
  const html = renderMarkdown('www.example.com main.py example.com https://example.com http://example.org person@example.com');
  const anchors = [];
  const walk = node => {
    if (node.name === 'a') anchors.push(node.attribs.href);
    for (const child of node.children || []) walk(child);
  };
  walk(parseDocument(html));
  assert.deepEqual(anchors, ['https://example.com', 'http://example.org', 'mailto:person@example.com']);
  assert.match(html, /www\.example\.com main\.py example\.com/);
});

test('ellipsis conversion does not rewrite URL text or explicit link labels', () => {
  const html = renderMarkdown('http://example.com/a...b [label...](https://example.org/a...b)\n\nOutside...');
  assert.match(html, /href="http:\/\/example.com\/a\.\.\.b">http:\/\/example.com\/a\.\.\.b<\/a>/);
  assert.match(html, /href="https:\/\/example.org\/a\.\.\.b">label\.\.\.<\/a>/);
  assert.match(html, /Outside…/);
});

test('backslashes leave entities, HTML and autolinks available to their parsers', () => {
  // Expected outputs were checked against the isolated Showdown 2.1.0 converter.
  assert.equal(renderMarkdown(String.raw`\&amp;`).trim(), String.raw`<p>\&amp;</p>`);
  assert.equal(renderMarkdown(String.raw`\<b>x</b>`).trim(), String.raw`<p>\<b>x</b></p>`);
  assert.equal(renderMarkdown(String.raw`\<https://example.com>`).trim(),
    String.raw`<p>\<a href="https://example.com">https://example.com</a></p>`);
});

test('only code language classes and the existing MathJax ignore span class survive', () => {
  const html = renderMarkdown('<div class="position-fixed top-0 start-0 w-100 h-100"><a class="btn" href="https://example.com">link</a></div>' +
    '<span class="tex2jax_ignore position-fixed">literal</span>' +
    '<code class="language-python position-fixed">code</code>');
  assert(!/position-fixed|top-0|start-0|w-100|h-100|class="btn"/.test(html));
  assert.match(html, /<span class="tex2jax_ignore">literal<\/span>/);
  assert.match(html, /<code class="language-python">code<\/code>/);
});

test('sanitization retains safe HTML and removes scripts, handlers, unsafe URLs and embeds', () => {
  const html = renderMarkdown('<span class="tex2jax_ignore">safe</span> <sup>2</sup>\n\n' +
    '<script>alert("script")</script><style>body{display:none}</style>' +
    '<iframe src="https://example.test">frame</iframe><svg onload="alert(1)"><script>alert(2)</script></svg>' +
    '<form action="/delete"><input name="x"></form>' +
    '<img src="https://example.test/a.png" onerror="alert(1)" alt="diagram">' +
    '<img src="data:image/svg+xml,bad">' +
    '<a href="java&#x0a;script:alert(1)" onclick="alert(1)">unsafe</a>' +
    '<a href="https://example.test">safe link</a>' +
    '<span style="position:fixed;background:url(javascript:alert(1))">text</span>');
  assert.match(html, /<span class="tex2jax_ignore">safe<\/span>/);
  assert.match(html, /<sup>2<\/sup>/);
  assert.match(html, /src="https:\/\/example.test\/a.png"/);
  assert.match(html, /href="https:\/\/example.test"/);
  const forbidden = new Set(['script', 'style', 'iframe', 'svg', 'math', 'form', 'input', 'object', 'embed']);
  const inspect = node => {
    assert(!forbidden.has(node.name));
    for (const [key, value] of Object.entries(node.attribs || {})) {
      assert(!/^on/i.test(key)); assert.notEqual(key, 'style');
      if (['src', 'href'].includes(key)) assert(!/^(javascript|data|vbscript):/i.test(value));
    }
    for (const child of node.children || []) inspect(child);
  };
  inspect(parseDocument(html));
  assert(!html.includes('alert('));
  assert.equal(sanitizeRenderedHtml('<script type="text/x-mathjax-config">unsafe()</script>'), '');
});

test('skill, problem and answer-review routes share sanitization and retain the trusted MathJax loader', async () => {
  const {app, db, ids} = fixture();
  const source = '**Synthetic lesson** <img src="x" onerror="untrusted()"><script>untrusted()</script>';
  db.Skill.rows[0].description = source;
  Object.assign(db.Problem.rows[0], {problemText: source, mimeType: 'markdown'});
  await serve(app, async request => {
    for (const url of [`/showSkill/${ids.course}/${ids.skill}`,
      `/showProblem/${ids.course}/${ids.pset}/${ids.problem}`,
      `/showReviewsOfAnswer/${ids.course}/${ids.pset}/${ids.answer}`]) {
      const response = await request(url, {user: ids.ta});
      assert.equal(response.status, 200);
      const {markdownText} = await response.json();
      assert.match(markdownText, /<strong>Synthetic lesson<\/strong>/);
      assert(!markdownText.includes('untrusted()'));
      assert(!markdownText.includes('onerror'));
      assert.match(markdownText, /MathJax\.Hub\.Config/);
      assert.match(markdownText, /mathjax\/2\.7\.7\/MathJax\.js/);
      assert.match(markdownText, /config=TeX-AMS-MML_HTMLorMML,Safe/);
    }
  });
  assert.equal(db.Problem.rows[0].problemText, source, 'stored content is not rewritten');
});

test('all four MathJax load sites enable the Safe extension', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const [file, count] of [['app.js', 3], ['routes/reviewsARCHIVED.js', 1]]) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const configs = [...source.matchAll(/MathJax\.js\?config=([^"\s]+)/g)].map(match => match[1]);
    assert.equal(configs.length, count);
    assert(configs.every(config => config.split(',').includes('Safe')));
  }
});

test('comparison accounts for every record and preserves meaningful differences', () => {
  assert.equal(canonicalHtml('<p>text</p>\n'), canonicalHtml('<p>text</p>'));
  assert.notEqual(canonicalHtml('<pre>a  b</pre>'), canonicalHtml('<pre>a b</pre>'));
  assert.notEqual(canonicalHtml('<p>a&nbsp;b</p>'), canonicalHtml('<p>a b</p>'));
  assert.notEqual(canonicalHtml('<a href="/one">x</a>'), canonicalHtml('<a href="/two">x</a>'));
  const report = compareCorpus({problems: [{_id: 'p', mimeType: 'tex', problemText: '\\alpha'}],
    skills: [{_id: 's', description: 'synthetic'}]}, {makeHtml: () => '<p>synthetic</p>'});
  assert.equal(report.counts.passthrough, 1);
  assert.equal(report.counts.rendered, 1);
  assert.equal(report.counts.identical, 1);
  assert.equal(report.records.length, 2);
});

test('comparison preserves extended JSON IDs and counts only bare www links that stop linking', () => {
  const problemId = '000000000000000000000001', skillId = '000000000000000000000002';
  const report = compareCorpus({
    problems: [{_id: {$oid: problemId}, mimeType: 'markdown', problemText: 'www.example.com'}],
    skills: [{_id: {$oid: skillId}, description: '[www.example.com](https://www.example.com)'}],
  }, {makeHtml: source => source.startsWith('[') ? '<p><a href="https://www.example.com">www.example.com</a></p>' :
    '<p><a href="http://www.example.com">www.example.com</a></p>'});
  assert.deepEqual(report.records.map(row => row.id), [problemId, skillId]);
  assert.deepEqual(report.counts.bareWwwNoLongerLinked, {problems: 1, skills: 0, occurrences: 1});
});

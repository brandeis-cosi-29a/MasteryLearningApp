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

test('sanitization retains safe HTML and removes scripts, handlers, unsafe URLs and embeds', () => {
  const html = renderMarkdown('<span class="mathjax">safe</span> <sup>2</sup>\n\n' +
    '<script>alert("script")</script><style>body{display:none}</style>' +
    '<iframe src="https://example.test">frame</iframe><svg onload="alert(1)"><script>alert(2)</script></svg>' +
    '<form action="/delete"><input name="x"></form>' +
    '<img src="https://example.test/a.png" onerror="alert(1)" alt="diagram">' +
    '<img src="data:image/svg+xml,bad">' +
    '<a href="java&#x0a;script:alert(1)" onclick="alert(1)">unsafe</a>' +
    '<a href="https://example.test">safe link</a>' +
    '<span style="position:fixed;background:url(javascript:alert(1))">text</span>');
  assert.match(html, /<span class="mathjax">safe<\/span>/);
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
    }
  });
  assert.equal(db.Problem.rows[0].problemText, source, 'stored content is not rewritten');
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

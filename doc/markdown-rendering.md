# Markdown rendering

`config/markdown.js` renders skill descriptions and Markdown problem text with
markdown-it, then sanitizes the resulting HTML with sanitize-html. The skill,
problem, and answer-review handlers share this renderer. The archived review
router also uses it, so loading archived code does not require Showdown.

Existing support for headings, emphasis, fenced code, tables, strikethrough,
and safe inline HTML remains. Automatic linking recognizes `http://` and
`https://` URLs and email addresses. Bare `www.example.com`, `example.com` and
filenames such as `main.py` remain text. Instructors should write
`https://www.example.com` to make a bare `www.` address link. Fuzzy linking stays
disabled. Compatibility rules retain heading
anchors (including repeated headings), literal intraword asterisks, ellipses,
and the prior Markdown backslash-escape set. In particular, TeX spacing commands
such as `\;` and `\,` reach the existing MathJax loader. Code blocks retain their
literal text. This preserves the existing Markdown/TeX convention; authors still
need to double a Markdown backslash when a literal TeX backslash would otherwise
be consumed as a Markdown escape.

The sanitizer allows normal document formatting, tables, safe links and images,
and heading IDs. Classes are limited to `language-*` on code elements and the
existing `tex2jax_ignore` class on spans. Arbitrary classes, including Bootstrap
positioning utilities, are stripped. It removes content-supplied scripts, event handlers,
forms, embedded documents, SVG/MathML, unsafe URL schemes, and arbitrary inline
styles. Table-cell text alignment is allowed. Data-URL images are not allowed.
The application adds its trusted MathJax scripts after sanitization; source
content cannot provide scripts. All four loaders enable the MathJax 2.7 Safe
extension, which restricts TeX-generated URLs, classes, CSS IDs, styles and
extension loading using its defaults. HTTP(S) `\href` remains supported. See the
[MathJax Safe options](https://docs.mathjax.org/en/v2.7/options/other/Safe.html).
The HTML sanitizer alone does not filter TeX commands; Safe applies when MathJax
typesets them in the browser. Sanitization happens at render time and does not
rewrite stored text. Non-Markdown source and LaTeX exam exports are not converted
by this renderer.

markdown-it follows CommonMark, so some layouts differ from Showdown: `1)` can
start a numbered list, continuation numbering immediately after a paragraph may
remain text, different unordered-list marker types can split a list, unclosed
code fences can produce a code block, and trailing code-block blank lines can
remain visible. Check these cases in the compatibility report before deployment.

## Compatibility comparison

Run `npm test` for synthetic formatting, TeX-escape, sanitizer and route checks.
To compare a local content export, use this JSON shape:

```json
{
  "problems": [{"_id": "example-problem", "mimeType": "markdown", "problemText": "**Example**"}],
  "skills": [{"_id": "example-skill", "description": "Example skill"}]
}
```

Install the old renderer in a separate temporary directory, outside the app's
dependency tree, then pass its absolute module path to the comparison script:

```sh
npm install --prefix /tmp/mla-legacy-markdown --ignore-scripts --no-audit --no-fund showdown@2.1.0
node scripts/compare-markdown.cjs /path/to/content.json /private/path/new-report.json /tmp/mla-legacy-markdown/node_modules/showdown
```

The report accounts for every problem and skill. Non-Markdown problems are
marked as passthrough; they are not converted to HTML by these handlers. Rendered
records are classified as identical (ignoring outer whitespace), serialization/
whitespace changes, layout changes, or text changes. HTML comparisons preserve
code whitespace, inline spacing, link targets and heading anchors; visual
equivalence is not guaranteed by a text/DOM comparison. The report also checks
whether sanitizing the legacy HTML would change its DOM.
The aggregate `bareWwwNoLongerLinked` counts report affected problems, skills,
and occurrences, excluding links that remain explicit and linked. Extended JSON
IDs (`{"$oid": "..."}`) from mongoexport/Compass are supported.

Differences include the source and both HTML outputs. Keep content exports and
reports outside version control. The script requires a new explicit output
filename and writes it with private file permissions; it makes no network or
database calls. Review any layout/text changes and smoke-test a representative
skill, Markdown problem and reviewed answer in a test course before deployment.

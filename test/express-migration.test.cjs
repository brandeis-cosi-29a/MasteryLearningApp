const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture, serve} = require('./helpers/app.cjs');

test('errors after headers are sent reach the next handler without writing another response', async () => {
  const {app} = fixture();
  const failure = new Error('Synthetic failure after response');
  let resolveForwarded;
  const forwarded = new Promise(resolve => {resolveForwarded = resolve;});
  app.get('/synthetic-late-error', async (req, res) => {
    res.send('Response already sent');
    throw failure;
  });
  // Put only this synthetic route before the production middleware, retaining
  // the application's real error handler and Express's async rejection path.
  app.router.stack.unshift(app.router.stack.pop());
  app.use((error, req, res, next) => {resolveForwarded(error);});
  await serve(app, async request => {
    const response = await request('/synthetic-late-error');
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'Response already sent');
    assert.equal(await forwarded, failure);
  });
});

test('rejected async model calls reach the application error page and leave the server usable', async () => {
  for (const environment of ['production', 'test']) {
    const f = fixture({realViews: true});
    f.app.set('env', environment);
    f.db.Course.countDocuments = async () => {throw new Error('Synthetic database failure');};
    await serve(f.app, async request => {
      const response = await request('/stats', {user: f.ids.owner});
      assert.equal(response.status, 500);
      const html = await response.text();
      assert.match(html, /Error - Something went wrong\. Please try again\./);
      assert.doesNotMatch(html, /Synthetic database failure|at .*app\.js|at .*node_modules/);
      assert.equal((await request('/about', {user: f.ids.owner})).status, 200);
    });
    assert.deepEqual(f.writes, []);
  }
});

test('development error pages retain the original message and stack', async () => {
  const f = fixture({realViews: true});
  f.app.set('env', 'development');
  f.db.Course.countDocuments = async () => {throw new Error('Synthetic development failure');};
  await serve(f.app, async request => {
    const response = await request('/stats', {user: f.ids.owner});
    assert.equal(response.status, 500);
    const html = await response.text();
    assert.match(html, /Error - Synthetic development failure/);
    assert.match(html, /Error: Synthetic development failure/);
    assert.match(html, /at .*app\.js/);
  });
  assert.deepEqual(f.writes, []);
});

test('flat query selectors and CSV exports work; repeated identity selectors cannot bypass scope checks', async () => {
  const f = fixture();
  await serve(f.app, async request => {
    const response = await request(`/showCourseToStudent/${f.ids.course}?studentEmail=classmate%40example.test`, {user: f.ids.ta});
    assert.equal(response.status, 200);
    assert.equal((await response.json()).theUser._id, String(f.ids.classmate));
    const csv = await request(`/showMastery/${f.ids.course}?csv=true`, {user: f.ids.ta});
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /^text\/csv/);
    assert.match(await csv.text(), /name,email,section/);
    const makeup = await request(`/addProblemSet/${f.ids.course}?makeupId=${f.ids.pset}`, {user: f.ids.owner});
    assert.equal(makeup.status, 200);
    assert.equal((await makeup.json()).makeup._id, String(f.ids.pset));
    for (const [url, user, status] of [
      [`/showCourseToStudent/${f.ids.course}?studentEmail=student%40example.test&studentEmail=classmate%40example.test`, f.ids.ta, 403],
      [`/uploadAnswerPhoto/${f.ids.course}/${f.ids.pset}/${f.ids.problem}?theStudentId=${f.ids.student}&theStudentId=${f.ids.classmate}`, f.ids.ta, 404],
      [`/addProblemSet/${f.ids.course}?makeupId=${f.ids.pset}&makeupId=${f.ids.otherPset}`, f.ids.owner, 404],
    ]) assert.equal((await request(url, {user, method: url.startsWith('/upload') ? 'POST' : 'GET'})).status, status);
  });
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.uploads, []);
});

test('URL-encoded and JSON submissions preserve answer text and redirects', async () => {
  for (const kind of ['form', 'json']) {
    const f = fixture();
    const answer = 'A + B & C < D; \\alpha';
    await serve(f.app, async request => {
      const response = await request(`/saveAnswer/${f.ids.course}/${f.ids.pset}/${f.ids.problem}`, {
        user: f.ids.student, method: 'POST',
        headers: {'content-type': kind === 'form' ? 'application/x-www-form-urlencoded' : 'application/json'},
        body: kind === 'form' ? new URLSearchParams({answer}) : JSON.stringify({answer}),
      });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), `/showProblem/${f.ids.course}/${f.ids.pset}/${f.ids.problem}`);
      const saved = f.db.Answer.rows.find(row => String(row.studentId) === String(f.ids.student));
      assert(saved);
      assert.equal(saved.answer, answer);
      assert.equal(String(saved.courseId), String(f.ids.course));
      assert.equal(String(saved.problemId), String(f.ids.problem));
    });
  }
});

test('unparsed request bodies preserve the legacy no-robots response without writes', async () => {
  const f = fixture({realViews: true});
  await serve(f.app, async request => {
    const response = await request('/createNewCourse', {user: f.ids.owner, method: 'POST'});
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'no robots allowed!');
  });
  assert.deepEqual(f.writes, []);
});

test('body-parser errors render their 400/413 pages before auth without writes', async () => {
  const f = fixture({realViews: true});
  f.app.set('env', 'production');
  await serve(f.app, async request => {
    for (const [type, body, status] of [
      ['application/json', '{"answer":', 400],
      ['application/json', JSON.stringify({answer: 'x'.repeat(110 * 1024)}), 413],
      ['application/x-www-form-urlencoded', 'answer=' + 'x'.repeat(110 * 1024), 413],
    ]) {
      const response = await request(`/saveAnswer/${f.ids.course}/${f.ids.pset}/${f.ids.problem}`, {
        user: f.ids.student, method: 'POST', headers: {'content-type': type}, body,
      });
      assert.equal(response.status, status);
      const html = await response.text();
      assert.match(html, /<h1 class="pb-2 border-bottom">Error -/);
      assert.match(html, status === 413 ? /Your submission was too large\./ : /Your submission could not be read\./);
      assert.match(html, /You may still be signed in/);
      assert.match(html, /Back button and try again/);
      assert.doesNotMatch(html, /href="\/(?:auth\/google|logout|profile)"|SyntaxError|entity\.(?:parse\.failed|too\.large)/);
      assert.doesNotMatch(html, /ReferenceError|loggedIn is not defined|at .*node_modules/);
    }
    assert.equal((await request('/about', {user: f.ids.owner})).status, 200);
  });
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.uploads, []);
});

test('static scripts, styles and fonts retain usable MIME types and unavailable paths stay unavailable', async () => {
  const {app} = fixture({realViews: true});
  await serve(app, async request => {
    for (const [url, mime] of [
      ['/js/sort-table.js', /^text\/javascript/],
      ['/stylesheets/style.css', /^text\/css/],
      ['/fontawesome/css/all.min.css', /^text\/css/],
      ['/fontawesome/webfonts/fa-solid-900.woff2', /^font\/woff2/],
    ]) {
      const response = await request(url);
      assert.equal(response.status, 200, url);
      assert.match(response.headers.get('content-type'), mime);
      assert((await response.arrayBuffer()).byteLength > 0);
    }
    for (const url of ['/no-such-route', '/.env', '/.well-known/no-such-file', '/answerImages/no-such-file.png']) {
      assert.equal((await request(url)).status, 404, url);
    }
  });
});

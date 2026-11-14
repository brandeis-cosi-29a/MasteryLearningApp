const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture, serve} = require('./helpers/app.cjs');
const {id} = require('./helpers/models.cjs');

test('mounted routes keep course authorization and source-sharing checks explicit', () => {
  const {app, auth} = fixture();
  const routes = app._router.stack.flatMap(layer => layer.route ? [layer.route] : layer.handle.stack?.filter(x => x.route).map(x => x.route) || []);
  const recognized = new Set(['courseId', 'psetId', 'examId', 'probId', 'answerId',
    'reviewId', 'requestId', 'regradeRequestId', 'skillId', 'studentId', 'userId',
    'sourceProblemId', 'otherCourseId']);
  for (const route of routes.filter(route => route.path.includes(':courseId'))) {
    const handlers = route.stack.map(layer => layer.handle);
    assert(handlers.includes(auth.authorize) || handlers.includes(auth.isAdmin), route.path);
    for (const [token] of route.path.matchAll(/:([A-Za-z]+Id)\b/g)) {
      assert(recognized.has(token.slice(1)), `${route.path}: add scope checks for new identifier`);
    }
    if (/:(sourceProblemId|otherCourseId)\b/.test(route.path)) {
      assert(handlers.includes(auth.isOwner), route.path);
      assert(handlers.includes(auth.isInstructor), route.path);
      assert(handlers.some(handler => handler.name === 'requireMaterialSource'), route.path);
    }
  }
});

test('all mounted course routes reject foreign URL objects before handlers run', async () => {
  const {app, ids, writes, uploads} = fixture();
  const routes = app._router.stack.flatMap(layer => layer.route ? [layer.route] : layer.handle.stack?.filter(x => x.route).map(x => x.route) || []);
  const foreign = {psetId: 'otherPset', examId: 'otherPset', probId: 'otherProblem', answerId: 'otherAnswer', reviewId: 'otherReview', requestId: 'otherRequest', regradeRequestId: 'otherRequest', skillId: 'otherSkill', studentId: 'outsider'};
  const own = {courseId: 'course', psetId: 'pset', examId: 'pset', probId: 'problem', answerId: 'answer', reviewId: 'review', requestId: 'request', regradeRequestId: 'request', skillId: 'skill', studentId: 'classmate', userId: 'owner', sourceProblemId: 'otherProblem', otherCourseId: 'otherCourse'};
  let checks = 0;
  await serve(app, async request => {
    for (const route of routes.filter(route => route.path.includes(':courseId'))) {
      for (const [param, replacement] of Object.entries(foreign)) {
        if (!route.path.includes(`:${param}`)) continue;
        const url = route.path.replace(/:([A-Za-z]+)/g, (_, key) => String(ids[key === param ? replacement : own[key]] || 'test'));
        const method = Object.keys(route.methods)[0].toUpperCase();
        const response = await request(url, {user: ids.owner, method});
        assert.equal(response.status, 404, `${method} ${route.path}: foreign ${param}`);
        checks++;
      }
    }
  });
  assert(checks >= 65, `expected broad route coverage, checked ${checks}`);
  assert.equal(writes.length, 0);
  assert.equal(uploads.length, 0);
});

test('URL parents must agree even when every object is in the authorized course', async () => {
  const {app, db, ids, writes} = fixture();
  const pset = id(500);
  db.ProblemSet.rows.push({_id: pset, courseId: ids.course});
  await serve(app, async request => {
    for (const url of [
      `/showProblem/${ids.course}/${pset}/${ids.problem}`,
      `/showReviewsOfAnswer/${ids.course}/${pset}/${ids.answer}`,
      `/saveReview2/${ids.course}/${pset}/${ids.problem}/${ids.answer}`,
    ]) assert.equal((await request(url, {user: ids.owner, method: url.startsWith('/save') ? 'POST' : 'GET'})).status, 404);
    db.Answer.rows[0].psetId = pset;
    assert.equal((await request(`/showReviewsOfAnswer/${ids.course}/${ids.pset}/${ids.answer}`, {user: ids.owner})).status, 404);
  });
  assert.equal(writes.length, 0);
});

test('body and query IDs cannot smuggle foreign records into authorized actions', async () => {
  const {app, ids, writes, uploads} = fixture();
  await serve(app, async request => {
    for (const [path, body] of [
      [`saveProblemSet/${ids.course}`, `name=Test&makeupOf=${ids.otherPset}`],
      [`setAsMakeup/${ids.course}/${ids.pset}`, `makeupSet=${ids.otherPset}`],
      [`saveProblem/${ids.course}/${ids.pset}`, `skills=${ids.otherSkill}`],
    ]) assert.equal((await request('/' + path, {user: ids.owner, method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}, body})).status, 404);
    assert.equal((await request(`/uploadAnswerPhoto/${ids.course}/${ids.pset}/${ids.problem}?theStudentId=${ids.outsider}`, {user: ids.ta, method: 'POST'})).status, 404);
    assert.equal((await request(`/uploadAnswerPhoto/${ids.course}/${ids.pset}/${ids.problem}?theStudentId=${ids.classmate}`, {user: ids.student, method: 'POST'})).status, 403);
    const body = new FormData(); body.set('psetId', String(ids.otherPset));
    assert.equal((await request(`/uploadGrades/${ids.course}`, {user: ids.owner, method: 'POST', body})).status, 404);
    assert.equal((await request(`/showProblem/${ids.course}/invalid/${ids.problem}`, {user: ids.owner})).status, 404);
    assert.equal((await request(`/showCourse/${ids.course}`, {user: ids.outsider})).status, 403);
  });
  assert.equal(writes.length, 0);
  assert.equal(uploads.length, 0);
});

test('existing course access survives missing owner approval while new creation and foreign records remain denied', async () => {
  const {app, db, ids, writes} = fixture();
  db.Instructor.rows.length = 0;
  await serve(app, async request => {
    for (const user of [ids.owner, ids.ta, ids.student]) {
      assert.equal((await request(`/showCourse/${ids.course}`, {user})).status, 302);
    }
    assert.equal((await request(`/getGradesAsJSON/${ids.course}`, {user: ids.ta})).status, 200);
    assert.equal((await request(`/showReviewsOfAnswer/${ids.course}/${ids.pset}/${ids.otherAnswer}`, {user: ids.owner})).status, 404);
    assert.equal((await request('/createNewCourse', {user: ids.owner, method: 'POST',
      headers: {'content-type': 'application/x-www-form-urlencoded'}, body: 'courseName=Test&norobot=on',
    })).status, 403);
  });
  assert.equal(writes.length, 0);
});

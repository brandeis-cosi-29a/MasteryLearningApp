const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture, serve} = require('./helpers/app.cjs');
const {id} = require('./helpers/models.cjs');

// A 30-minute-old assignment, released (or not) when a classmate's /reviewAnswers
// runs the expiry sweep, then submitted by the original reviewer.
async function submitAfterThirtyMinutes(env) {
  const {app, db, ids} = fixture({env});
  db.Course.rows[0].courseType = 'pra';
  db.Answer.rows.push({_id: id(501), courseId: ids.course, psetId: ids.pset,
    problemId: ids.problem, studentId: ids.student, answer: 'own submission',
    reviewers: [], pendingReviewers: [], numReviews: 0});
  let status;
  await serve(app, async request => {
    const assignment = await request(`/reviewAnswers/${ids.course}/${ids.pset}/${ids.problem}`, {user: ids.student});
    assert.equal(assignment.headers.get('location'), `/showReviewsOfAnswer/${ids.course}/${ids.pset}/${ids.answer}`);
    for (const pending of db.Problem.rows[0].pendingReviews) pending.timeSent = new Date().getTime() - 30 * 60 * 1000;
    await request(`/reviewAnswers/${ids.course}/${ids.pset}/${ids.problem}`, {user: ids.classmate});
    status = (await request(`/saveReview2/${ids.course}/${ids.pset}/${ids.problem}/${ids.answer}`, {
      user: ids.student, method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'},
      body: 'review=Slow+but+careful&goodFaithEffort=yes',
    })).status;
  });
  return status;
}

test('PEER_REVIEW_TIMEOUT_MINUTES sets how long a peer-review assignment survives', async () => {
  assert.equal(await submitAfterThirtyMinutes({PEER_REVIEW_TIMEOUT_MINUTES: '60'}), 302, '60-minute window keeps the assignment');
  assert.equal(await submitAfterThirtyMinutes({}), 403, 'default 10-minute window releases it');
  assert.equal(await submitAfterThirtyMinutes({PEER_REVIEW_TIMEOUT_MINUTES: 'an hour'}), 403, 'invalid value falls back to 10 minutes');
});

function ownSubmission(db, ids) {
  db.Answer.rows.push({_id: id(501), courseId: ids.course, psetId: ids.pset,
    problemId: ids.problem, studentId: ids.student, answer: 'own submission',
    reviewers: [], pendingReviewers: [], numReviews: 0});
}

function completedReview(db, ids, n) {
  const answerId = id(600 + n);
  db.Answer.rows.push({...db.Answer.rows[0], _id: answerId, imageFilePath: undefined,
    reviewers: [ids.student], answer: `class content ${n}`, pendingReviewers: []});
  db.Review.rows.push({...db.Review.rows[0], _id: id(700 + n), answerId,
    reviewerId: ids.student, review: 'my own review'});
}

test('ordinary students cannot read or grade unassigned classmates, even in their own course', async () => {
  const {app, ids, writes} = fixture();
  await serve(app, async request => {
    for (const [url, method, body] of [
      [`/showReviewsOfAnswer/${ids.course}/${ids.pset}/${ids.answer}`, 'GET'],
      [`/showReviewsOfAnswer/${ids.course}/${ids.pset}/${ids.answer}?personal=true`, 'GET'],
      [`/gradeProblem/${ids.course}/${ids.pset}/${ids.problem}/${ids.classmate}`, 'GET'],
      [`/saveReview2/${ids.course}/${ids.pset}/${ids.problem}/${ids.answer}`, 'POST', 'review=forged'],
      [`/requestRegrade/${ids.course}/${ids.review}`, 'POST', 'reason=forged'],
      [`/removeReviews/${ids.course}`, 'POST', `deletes=${ids.review}`],
      [`/thumbsU/${ids.course}/select/${ids.review}/${ids.student}`, 'GET'],
    ]) assert.equal((await request(url, {user: ids.student, method, body,
      headers: body ? {'content-type': 'application/x-www-form-urlencoded'} : {}})).status, 403, url);
  });
  assert.equal(writes.length, 0);
});

test('peer assignment supports review and history without exposing identities, grades or other feedback', async () => {
  const {app, db, ids} = fixture({realViews: true});
  db.Course.rows[0].courseType = 'pra';
  ownSubmission(db, ids);
  await serve(app, async request => {
    const assignment = await request(`/reviewAnswers/${ids.course}/${ids.pset}/${ids.problem}`, {user: ids.student});
    assert.equal(assignment.status, 302);
    assert.equal(assignment.headers.get('location'), `/showReviewsOfAnswer/${ids.course}/${ids.pset}/${ids.answer}`);
    const view = await request(assignment.headers.get('location'), {user: ids.student});
    assert.equal(view.status, 200);
    const html = await view.text();
    assert.match(html, /Assigned answer/);
    for (const secret of ['classmate@example.test', String(ids.classmate), 'official feedback', 'protected feedback', 'Submission time']) assert(!html.includes(secret), secret);
    const submitted = await request(`/saveReview2/${ids.course}/${ids.pset}/${ids.problem}/${ids.answer}`, {
      user: ids.student, method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'},
      body: 'review=Helpful+peer+feedback&goodFaithEffort=yes&destination=submit+and+view+this+again',
    });
    assert.equal(submitted.status, 302);
    assert.equal(db.Answer.rows[0].points, 99, 'peer cannot replace official grade');
    assert.equal(db.Review.rows.filter(r => String(r.reviewerId) === String(ids.student)).length, 1);
    const again = await request(assignment.headers.get('location'), {user: ids.student});
    assert.match(await again.text(), /Helpful peer feedback/);
    assert.equal((await request(`/saveReview2/${ids.course}/${ids.pset}/${ids.problem}/${ids.answer}`, {
      user: ids.student, method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}, body: 'review=duplicate',
    })).status, 403);
    const history = await request(`/showReviewsByUser/${ids.course}/${ids.pset}/${ids.problem}`, {user: ids.student});
    assert.equal(history.status, 200);
    const historyHtml = await history.text();
    assert.match(historyHtml, /Helpful peer feedback/);
    assert(!historyHtml.includes('protected feedback'));
    assert(!historyHtml.includes('grade:'));
    db.Problem.rows[0].peerReviewable = false;
    assert.equal((await request(assignment.headers.get('location'), {user: ids.student})).status, 403);
  });
});

test('class-wide browsing requires two distinct assigned reviews and returns answer content only', async () => {
  const {app, db, ids} = fixture({realViews: true});
  db.Course.rows[0].courseType = 'pra';
  const url = `/showAllAnswers/${ids.course}/${ids.problem}`;
  await serve(app, async request => {
    assert.equal((await request(url, {user: ids.student})).status, 403);
    ownSubmission(db, ids);
    completedReview(db, ids, 1);
    db.Review.rows.push({...db.Review.rows.at(-1), _id: id(800)});
    assert.equal((await request(url, {user: ids.student})).status, 403, 'duplicate reviews do not count twice');
    completedReview(db, ids, 2);
    const allowed = await request(url, {user: ids.student});
    assert.equal(allowed.status, 200);
    const html = await allowed.text();
    assert.match(html, /class content 1/);
    for (const secret of ['classmate@example.test', String(ids.classmate), 'official feedback', 'protected feedback', 'my own review', 'Submission time']) assert(!html.includes(secret), secret);
    db.Course.rows[0].courseType = 'mla1';
    assert.equal((await request(url, {user: ids.student})).status, 403);
  });
});

test('staff retain grading, and mixed-course bulk deletion fails before all writes', async () => {
  const {app, db, ids, writes} = fixture();
  await serve(app, async request => {
    assert.equal((await request(`/showReviewsOfAnswer/${ids.course}/${ids.pset}/${ids.answer}`, {user: ids.ta})).status, 200);
    assert.equal((await request(`/saveReview2/${ids.course}/${ids.pset}/${ids.problem}/${ids.answer}`, {
      user: ids.ta, method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'},
      body: `review=Official+update&skill=${ids.skill}&points=1&destination=submit+and+view+this+again`,
    })).status, 302);
    assert.equal(db.Answer.rows[0].review, 'Official update');
    const before = writes.length;
    assert.equal((await request(`/removeReviews/${ids.course}`, {user: ids.owner,
      method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'},
      body: `deletes=${ids.review}&deletes=${ids.otherReview}`,
    })).status, 404);
    assert.equal(writes.length, before);
    assert.equal((await request(`/removeReviews/${ids.course}`, {user: ids.owner,
      method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'},
      body: `deletes=${db.Answer.rows[0].officialReviewId}`,
    })).status, 302);
    assert.equal(db.Answer.rows[0].officialReviewId, undefined);
    assert.equal(db.Answer.rows[0].points, undefined);
  });
});

const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture, serve} = require('./helpers/app.cjs');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
function photo(bytes = PNG) {
  const form = new FormData();
  form.set('picture', new Blob([bytes], {type: 'image/png'}), 'answer.png');
  return form;
}

test('denied multipart answer uploads write no bytes; fileless submissions preserve records', async () => {
  const {app, db, ids, writes, uploads} = fixture();
  await serve(app, async request => {
    const url = `/uploadAnswerPhoto/${ids.course}/${ids.pset}/${ids.problem}`;
    for (const [user, target, status] of [[ids.student, `?theStudentId=${ids.classmate}`, 403],
      [ids.ta, `?theStudentId=${ids.outsider}`, 404]]) {
      assert.equal((await request(url + target, {user, method: 'POST', body: photo()})).status, status);
    }
    assert.equal((await request(`/uploadAnswerPhoto/${ids.course}/${ids.pset}/${ids.otherProblem}`, {
      user: ids.ta, method: 'POST', body: photo(),
    })).status, 404);
    const before = JSON.stringify(db.Answer.rows);
    for (const user of [ids.student, ids.ta]) {
      assert.equal((await request(url, {user, method: 'POST', body: new FormData()})).status, 400);
    }
    assert.equal(JSON.stringify(db.Answer.rows), before);
    assert.equal(writes.length, 0);
    assert.equal(uploads.length, 0);
  });
});

test('student first upload and staff replacement retain protected-image and grading workflows', async () => {
  const {app, db, ids, imageObjects} = fixture();
  await serve(app, async request => {
    const url = `/uploadAnswerPhoto/${ids.course}/${ids.pset}/${ids.problem}`;
    const first = await request(url, {user: ids.student, method: 'POST', body: photo()});
    assert.equal(first.status, 302);
    const answer = db.Answer.rows.find(row => String(row.studentId) === String(ids.student));
    assert(answer);
    assert(imageObjects.has(new URL(answer.imageFilePath).pathname.slice(1)));
    const image = await request(`/answerImage/${ids.course}/${answer._id}`, {user: ids.student});
    assert.equal(image.status, 200);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);
    db.Answer.rows[0].officialReviewId = ids.review;
    const originalId = String(db.Answer.rows[0]._id);
    const reviews = JSON.stringify(db.Review.rows);
    const replacement = await request(url + `?theStudentId=${ids.classmate}`, {user: ids.ta, method: 'POST', body: photo()});
    assert.equal(replacement.status, 302);
    assert.equal(replacement.headers.get('location'), `/showReviewsOfAnswer/${ids.course}/${ids.pset}/${originalId}`);
    assert.equal(String(db.Answer.rows[0]._id), originalId);
    assert.equal(String(db.Answer.rows[0].officialReviewId), String(ids.review));
    assert.equal(JSON.stringify(db.Review.rows), reviews);
    const updated = await request(`/answerImage/${ids.course}/${ids.answer}`, {user: ids.classmate});
    assert.deepEqual(Buffer.from(await updated.arrayBuffer()), PNG);
  });
});

test('oversized photos retain existing answers and return 413', async () => {
  const {app, db, ids, writes} = fixture({env: {MAX_UPLOAD_MB: '0.001'}});
  const before = JSON.stringify(db.Answer.rows);
  await serve(app, async request => {
    const response = await request(`/uploadAnswerPhoto/${ids.course}/${ids.pset}/${ids.problem}?theStudentId=${ids.classmate}`, {
      user: ids.ta, method: 'POST', body: photo(Buffer.alloc(2048)),
    });
    assert.equal(response.status, 413);
    assert.equal(JSON.stringify(db.Answer.rows), before);
    assert.equal(writes.length, 0);
  });
});

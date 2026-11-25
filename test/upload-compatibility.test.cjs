const test = require('node:test');
const assert = require('node:assert/strict');
const {Readable} = require('node:stream');
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
  const {app, db, ids, imageObjects, s3} = fixture();
  const oldKey = new URL(db.Answer.rows[0].imageFilePath).pathname.slice(1);
  imageObjects.set(oldKey, Buffer.from('original answer image'));
  await serve(app, async request => {
    const url = `/uploadAnswerPhoto/${ids.course}/${ids.pset}/${ids.problem}`;
    const first = await request(url, {user: ids.student, method: 'POST', body: photo()});
    assert.equal(first.status, 302);
    const answer = db.Answer.rows.find(row => String(row.studentId) === String(ids.student));
    assert(answer);
    assert(imageObjects.has(new URL(answer.imageFilePath).pathname.slice(1)));
    assert.equal(s3.requests.find(r => r.method === 'PUT').headers['x-amz-acl'], 'private');
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
    assert.equal(imageObjects.get(oldKey).toString(), 'original answer image', 'replacement keeps the old object');
    assert.equal(s3.deletes.at(-1), `test-bucket.s3.us-east-1.amazonaws.com/${oldKey}`, 'legacy replacement deletion remains ineffective');
    const updated = await request(`/answerImage/${ids.course}/${ids.answer}`, {user: ids.classmate});
    assert.deepEqual(Buffer.from(await updated.arrayBuffer()), PNG);
  });
});

test('large photos use private multipart uploads and retain exact image bytes', async () => {
  const {app, db, ids, imageObjects, s3} = fixture();
  const bytes = Buffer.alloc(6 * 1024 * 1024, 0x61);
  PNG.copy(bytes);
  await serve(app, async request => {
    const response = await request(`/uploadAnswerPhoto/${ids.course}/${ids.pset}/${ids.problem}`, {
      user: ids.student, method: 'POST', body: photo(bytes),
    });
    assert.equal(response.status, 302);
    const answer = db.Answer.rows.find(row => String(row.studentId) === String(ids.student));
    const key = new URL(answer.imageFilePath).pathname.slice(1);
    assert.match(key, new RegExp(`^studentImages/${ids.student}/${ids.problem}/\\d+_\\.png$`));
    assert.deepEqual(imageObjects.get(key), bytes);
    const start = s3.requests.find(r => r.method === 'POST' && 'uploads' in r.query);
    assert.equal(start.headers['x-amz-acl'], 'private');
    assert.equal(s3.requests.filter(r => r.method === 'PUT' && r.query.uploadId).length, 2);
    assert.equal(s3.multipart.size, 0, 'completed multipart session is closed');
    const image = await request(`/answerImage/${ids.course}/${answer._id}`, {user: ids.student});
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
  });
});

test('failed S3 uploads preserve existing answers and do not attempt replacement deletion', async () => {
  for (const multipart of [false, true]) {
    const {app, db, ids, writes, s3} = fixture({s3Response: request => {
      if (request.method === 'PUT') return {statusCode: 403, headers: {},
        body: Readable.from(['<Error><Code>AccessDenied</Code><Message>Synthetic denial</Message></Error>'])};
    }});
    const before = JSON.stringify(db.Answer.rows);
    await serve(app, async request => {
      const response = await request(`/uploadAnswerPhoto/${ids.course}/${ids.pset}/${ids.problem}?theStudentId=${ids.classmate}`, {
        user: ids.ta, method: 'POST', body: photo(multipart ? Buffer.alloc(6 * 1024 * 1024) : PNG),
      });
      assert.equal(response.status, 500);
      assert.equal(JSON.stringify(db.Answer.rows), before);
      assert.equal(writes.length, 0);
      assert.equal(s3.deletes.length, 0);
      assert.equal(s3.multipart.size, 0, 'failed multipart uploads are aborted');
      if (multipart) assert(s3.requests.some(r => r.method === 'DELETE' && r.query.uploadId));
    });
  }
});

test('administrative student-data deletion still removes the actual image keys', async () => {
  const {app, db, ids, imageObjects, s3} = fixture();
  db.User.rows[0].googleemail = 'admin@example.test';
  const key = new URL(db.Answer.rows[0].imageFilePath).pathname.slice(1);
  imageObjects.set(key, PNG);
  await serve(app, async request => {
    const response = await request(`/deleteStudentData/${ids.course}`, {user: ids.owner});
    assert.equal(response.status, 302);
    assert.deepEqual(s3.deletes, [key]);
    assert(!imageObjects.has(key));
    assert(!db.Answer.rows.some(row => String(row.courseId) === String(ids.course)));
    assert(db.Answer.rows.some(row => String(row.courseId) === String(ids.otherCourse)));
  });
});

test('administrative deletion logs a failed S3 key and continues to later answers', async () => {
  let attempted = 0;
  const {app, db, ids, imageObjects, s3, errors} = fixture({s3Response: request => {
    if (request.method === 'DELETE' && ++attempted === 1) throw Error('Synthetic delete failure');
  }});
  db.User.rows[0].googleemail = 'admin@example.test';
  const firstKey = new URL(db.Answer.rows[0].imageFilePath).pathname.slice(1);
  const secondKey = 'studentImages/next.png';
  db.Answer.rows.push({...db.Answer.rows[0], _id: ids.request,
    imageFilePath: `https://test-bucket.s3.us-east-1.amazonaws.com/${secondKey}`});
  imageObjects.set(firstKey, PNG);
  imageObjects.set(secondKey, PNG);
  await serve(app, async request => {
    const response = await request(`/deleteStudentData/${ids.course}`, {user: ids.owner});
    assert.equal(response.status, 302);
    assert.equal(attempted, 2, 'later objects are attempted after a rejection');
    assert.deepEqual(s3.deletes, [secondKey]);
    assert(imageObjects.has(firstKey));
    assert(!imageObjects.has(secondKey));
    assert(errors.includes(`with key ${firstKey}`));
    assert(errors.some(message => message.includes('Synthetic delete failure')));
    assert(!errors.some(message => message.includes('ReferenceError')));
    assert(!db.Answer.rows.some(row => String(row.courseId) === String(ids.course)));
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

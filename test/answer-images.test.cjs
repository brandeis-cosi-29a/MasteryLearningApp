const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture, serve} = require('./helpers/app.cjs');
const {id} = require('./helpers/models.cjs');
const {load} = require('./helpers/load.cjs');
const {EventEmitter} = require('node:events');
const {validateStorageConfig, verifyPrivateBucket, objectKey, localImagePath} = require('../config/answerStorage');

test('answer images require actual record permission before any storage read', async () => {
  const {app, db, ids, imageReads} = fixture();
  const url = `/answerImage/${ids.course}/${ids.answer}`;
  await serve(app, async request => {
    assert.equal((await request(url)).status, 302);
    assert.equal((await request(url, {user: ids.outsider})).status, 403);
    assert.equal((await request(url, {user: ids.student})).status, 403);
    assert.equal((await request(`/answerImage/${ids.course}/${ids.otherAnswer}`, {user: ids.ta})).status, 404);
    assert.equal(imageReads.length, 0);
    for (const user of [ids.classmate, ids.ta, ids.owner]) {
      const response = await request(url, {user});
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.equal(response.headers.get('content-type'), 'image/png');
      assert.equal(await response.text(), 'synthetic image bytes');
    }
    const reads = imageReads.length;
    db.Answer.rows[0].imageFilePath = 'https://untrusted.example.test/other-image.png';
    assert.equal((await request(url, {user: ids.ta})).status, 404);
    assert.equal(imageReads.length, reads, 'unrecognized hosts are never fetched');
    for (const path of ['/answerImages/old.png', '/answerImages%2Fold.png', '/ANSWERIMAGES/old.png']) {
      assert.equal((await request(path)).status, 404);
    }
  });
});

test('image route retains assigned-peer and approved class-browsing access', async () => {
  const {app, db, ids} = fixture();
  db.Course.rows[0].courseType = 'pra';
  db.Answer.rows.push({_id: id(501), courseId: ids.course, psetId: ids.pset,
    problemId: ids.problem, studentId: ids.student, answer: 'own submission'});
  const url = `/answerImage/${ids.course}/${ids.answer}`;
  await serve(app, async request => {
    assert.equal((await request(url, {user: ids.student})).status, 403);
    db.Answer.rows[0].pendingReviewers = [ids.student];
    assert.equal((await request(url, {user: ids.student})).status, 200);
    db.Answer.rows[0].pendingReviewers = [];
    for (let n = 0; n < 2; n++) {
      const answerId = id(600 + n);
      db.Answer.rows.push({...db.Answer.rows[0], _id: answerId, reviewers: [ids.student]});
      db.Review.rows.push({...db.Review.rows[0], _id: id(700 + n), answerId, reviewerId: ids.student});
    }
    assert.equal((await request(url, {user: ids.student})).status, 200);
    db.Problem.rows[0].visible = false;
    assert.equal((await request(url, {user: ids.student})).status, 403);
  });
});

test('production requires private S3 storage; local storage is explicit testbed-only', async () => {
  const aws = {UPLOAD_TO: 'AWS', AWS_BUCKET_NAME: 'test-bucket', AWS_REGION: 'us-east-1'};
  const flags = {BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true};
  const s3 = {getPublicAccessBlock: () => ({promise: async () => ({PublicAccessBlockConfiguration: flags})})};
  await verifyPrivateBucket(s3, aws);
  for (const flag of Object.keys(flags)) {
    flags[flag] = false;
    await assert.rejects(verifyPrivateBucket(s3, aws), /four S3/);
    flags[flag] = true;
  }
  await assert.rejects(verifyPrivateBucket({getPublicAccessBlock: () => ({promise: async () => {throw Error('AccessDenied');}})}, aws));
  assert.throws(() => validateStorageConfig({NODE_ENV: 'production'}));
  assert.throws(() => validateStorageConfig({UPLOAD_TO: 'typo', NODE_ENV: 'development'}));
  assert.throws(() => validateStorageConfig({UPLOAD_TO: 'LOCAL', NODE_ENV: 'production', ALLOW_LOCAL_ANSWER_STORAGE: 'true'}));
  assert.throws(() => validateStorageConfig({UPLOAD_TO: 'LOCAL', NODE_ENV: 'development'}));
  assert.doesNotThrow(() => validateStorageConfig({UPLOAD_TO: 'LOCAL', NODE_ENV: 'development', ALLOW_LOCAL_ANSWER_STORAGE: 'true'}));
  assert.equal(objectKey('https://test-bucket.s3.us-east-1.amazonaws.com/studentImages/old.png', aws), 'studentImages/old.png');
  for (const value of ['https://other-bucket.s3.us-east-1.amazonaws.com/studentImages/old.png',
    'https://test-bucket.s3.us-east-1.amazonaws.com/other/old.png',
    'https://test-bucket.s3.us-east-1.amazonaws.com/studentImages/%2e%2e%2fsecret.png']) assert.throws(() => objectKey(value, aws));
  const filename = `${id(1)}_${id(2)}_123_.jpg`;
  assert.equal(localImagePath('local:' + filename, '/tmp/testbed'), '/tmp/testbed/' + filename);
  assert.throws(() => localImagePath('local:../secret', '/tmp/testbed'));
});

test('server waits for storage privacy and binds local testbeds only to loopback', async () => {
  for (const mode of ['AWS', 'LOCAL', 'rejected']) {
    let release, reject;
    const verification = new Promise((resolve, fail) => {release = resolve; reject = fail;});
    const listens = [], exits = [], errors = [];
    const server = new EventEmitter();
    server.listen = (...args) => listens.push(args);
    const app = {set() {}, locals: {verifyAnswerStorage: () => verification, localAnswerTestbed: mode === 'LOCAL'}};
    load('bin/www', {'../app': app, http: {createServer: () => server}}, {
      process: {env: {PORT: '5500'}, exit: code => exits.push(code)},
      console: {error(...args) {errors.push(args.join(' '));}},
    });
    assert.equal(listens.length, 0, 'must not listen before verification');
    if (mode === 'rejected') reject(Object.assign(Error('Access Denied'), {code: 'AccessDenied'})); else release();
    await new Promise(setImmediate);
    if (mode === 'rejected') {
      assert.deepEqual(exits, [1]); assert.equal(listens.length, 0);
      assert.match(errors.join('\n'), /FATAL.*Cause: AccessDenied: Access Denied/, 'log names the cause');
    }
    else assert.equal(JSON.stringify(listens), JSON.stringify([mode === 'LOCAL' ? [5500, '127.0.0.1'] : [5500]]));
  }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture, serve} = require('./helpers/app.cjs');
const {id} = require('./helpers/models.cjs');
const {load} = require('./helpers/load.cjs');
const {EventEmitter} = require('node:events');
const {Readable} = require('node:stream');
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

test('SDK image request and stream failures return unavailable without exposing S3 errors', async () => {
  for (const failure of ['NoSuchKey', 'AccessDenied', 'stream']) {
    const {app, ids} = fixture({s3Response: request => {
      if (request.method !== 'GET') return;
      if (failure === 'stream') return {statusCode: 200, headers: {},
        body: new Readable({read() {this.destroy(Error('Synthetic stream failure'));}})};
      return {statusCode: failure === 'NoSuchKey' ? 404 : 403, headers: {},
        body: Readable.from([`<Error><Code>${failure}</Code><Message>Synthetic provider detail</Message></Error>`])};
    }});
    await serve(app, async request => {
      const response = await request(`/answerImage/${ids.course}/${ids.answer}`, {user: ids.classmate});
      assert.equal(response.status, 404);
      assert(!(await response.text()).includes('Synthetic provider detail'));
    });
  }
});

test('an S3 response arriving after the browser disconnects releases its body stream', async () => {
  let handler;
  const router = {get(path, ...handlers) {handler = handlers.at(-1);}};
  const answerImages = load('routes/answerImages.js', {
    express: {Router: () => router}, './authFunctions': {},
    './recordAccess': {canReadAnswer: async () => true},
  });
  const body = new Readable({read() {}});
  const res = {destroyed: false};
  const env = {UPLOAD_TO: 'AWS', AWS_BUCKET_NAME: 'test-bucket', AWS_REGION: 'us-east-1'};
  answerImages({env, s3: {send: async () => {
    res.destroyed = true;
    return {Body: body};
  }}});
  await handler({courseScope: {answer: {imageFilePath: 'https://test-bucket.s3.us-east-1.amazonaws.com/studentImages/test.png'}}},
    res, error => {throw error;});
  assert(body.destroyed);
});

test('startup privacy verification uses the configured SDK region and fails closed on S3 errors', async () => {
  const {app, s3} = fixture({env: {AWS_REGION: 'eu-west-2', AWS_BUCKET_NAME: 'synthetic-private-bucket',
    AWS_ACCESS_KEY_ID: 'synthetic-app-key', AWS_SECRET_ACCESS_KEY: 'synthetic-app-secret'}});
  await app.locals.verifyAnswerStorage();
  assert.equal(s3.clientConfigs[0].region, 'eu-west-2');
  assert.equal(s3.clientConfigs[0].credentials.accessKeyId, 'synthetic-app-key');
  assert.equal(s3.clientConfigs[0].credentials.secretAccessKey, 'synthetic-app-secret');
  assert.equal(s3.requests[0].hostname, 'synthetic-private-bucket.s3.eu-west-2.amazonaws.com');
  assert('publicAccessBlock' in s3.requests[0].query);
  for (const body of ['<PublicAccessBlockConfiguration/>', '<Error><Code>AccessDenied</Code></Error>']) {
    const failed = fixture({s3Response: () => ({statusCode: body.includes('Error') ? 403 : 200,
      headers: {}, body: Readable.from([body])})});
    await assert.rejects(failed.app.locals.verifyAnswerStorage());
  }
});

test('production requires private S3 storage; local storage is explicit testbed-only', async () => {
  const aws = {UPLOAD_TO: 'AWS', AWS_BUCKET_NAME: 'test-bucket', AWS_REGION: 'us-east-1'};
  const flags = {BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true};
  const s3 = {send: async command => {
    assert.equal(command.constructor.name, 'GetPublicAccessBlockCommand');
    assert.equal(command.input.Bucket, aws.AWS_BUCKET_NAME);
    return {PublicAccessBlockConfiguration: flags};
  }};
  await verifyPrivateBucket(s3, aws);
  for (const flag of Object.keys(flags)) {
    flags[flag] = false;
    await assert.rejects(verifyPrivateBucket(s3, aws), /four S3/);
    flags[flag] = true;
  }
  await assert.rejects(verifyPrivateBucket({send: async () => {throw Error('AccessDenied');}}, aws));
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

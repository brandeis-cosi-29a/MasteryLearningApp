const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const {Passport} = require('passport');
const {load} = require('./helpers/load.cjs');
const {models, id} = require('./helpers/models.cjs');
const {fixture: courseFixture, serve} = require('./helpers/app.cjs');

function fixture(env = {}, storage = models()) {
  const {db, writes} = storage;
  const passport = new Passport();
  const configure = load('config/passport.js', {
    '../models/User': db.User, '../models/CourseMember': db.CourseMember,
    '../models/Instructor': db.Instructor, dotenv: {config() {}},
  }, {process: {env: {
    CLIENT_ID: 'synthetic-client', CLIENT_SECRET: 'synthetic-secret',
    CALLBACK_URL: 'http://localhost/login/authorized', ADMIN_EMAIL: ' ADMIN@EXAMPLE.TEST ', ...env,
  }}});
  configure(passport);
  const strategy = passport._strategy('google');
  let exchanges = 0;
  let claims;
  // Real Google strategy profile parser and Passport flow; only Google's two
  // network calls are simulated. No database, token, or credential files loaded.
  strategy._oauth2.getOAuthAccessToken = (code, params, done) => {
    exchanges++;
    done(null, 'synthetic-access-token', 'synthetic-refresh-token', {});
  };
  strategy._oauth2.get = (url, token, done) => done(null, JSON.stringify(claims));
  async function verify(json) {
    claims = json;
    const profile = await new Promise((resolve, reject) => strategy.userProfile('synthetic-access-token',
      (error, result) => error ? reject(error) : resolve(result)));
    return new Promise((resolve, reject) => strategy._verify('synthetic-access-token', 'synthetic-refresh-token',
      profile, (error, user) => error ? reject(error) : resolve(user)));
  }
  const app = express();
  app.use(session({secret: 'synthetic-session-secret', resave: false, saveUninitialized: false}));
  app.use(passport.initialize());
  app.use(passport.session());
  app.use(load('routes/authRouter.js', {passport, '../config/passport': () => {}}));
  app.get('/who', (req, res) => res.status(req.user ? 200 : 401).json({id: req.user?.id}));
  app.use((error, req, res, next) => res.status(500).send('Authentication error'));
  return {db, writes, verify, app, strategy, passport,
    setClaims(value) {claims = value;}, get exchanges() {return exchanges;}};
}

const identity = (overrides = {}) => ({
  sub: 'synthetic-google-id', email: 'new@brandeis.edu', email_verified: true,
  hd: 'brandeis.edu', name: 'Synthetic User', ...overrides,
});

test('verified Brandeis Google identity can provision; no Google tokens are stored', async () => {
  const f = fixture();
  const user = await f.verify(identity({email: ' New@Brandeis.edu '}));
  assert.equal(user.googleemail, 'new@brandeis.edu');
  assert.equal(user.googleid, 'synthetic-google-id');
  assert.equal(user.googletoken, undefined);
  assert.equal(f.db.User.rows.length, 1);
  assert.deepEqual(f.writes, [['User', 'save']]);
  assert.equal(f.db.CourseMember.rows.length, 0);
  assert.equal(f.db.Instructor.rows.length, 0);
});

test('email suffix, unverified claims and malformed Google profiles cannot provision', async () => {
  for (const overrides of [
    {hd: undefined}, {hd: 'other.edu'}, {hd: 'brandeis.edu.attacker.test'},
    {hd: 'BRANDEIS.EDU'}, {email_verified: false}, {email_verified: 'true'},
    {email_verified: undefined}, {email: undefined}, {email: ''},
    {email: 'invalid'}, {email: {$ne: null}}, {sub: undefined},
  ]) {
    const f = fixture();
    assert.equal(await f.verify(identity(overrides)), false, JSON.stringify(overrides));
    assert.deepEqual(f.writes, []);
    assert.equal(f.db.User.rows.length, 0);
  }
  const f = fixture();
  for (const profile of [undefined, {}, {provider: 'google', id: 'id', emails: [{value: 'new@brandeis.edu', verified: true}]},
    {provider: 'other', id: 'synthetic-google-id', _json: identity()},
    {provider: 'google', id: 'wrong-id', _json: identity()}]) {
    const user = await new Promise((resolve, reject) => f.strategy._verify('token', 'refresh', profile,
      (error, user) => error ? reject(error) : resolve(user)));
    assert.equal(user, false);
  }
  assert.deepEqual(f.writes, []);
});

test('new outsiders and existing self-provisioned outsiders are denied without any writes', async () => {
  for (const linked of [null, false, true]) {
    const f = fixture();
    if (linked !== null) f.db.User.rows.push({_id: id(1), googleemail: ' OUTSIDER@GMAIL.COM ',
      ...(linked ? {googleid: 'synthetic-google-id', googletoken: 'legacy-token'} : {})});
    const before = JSON.stringify(f.db.User.rows);
    assert.equal(await f.verify(identity({email: 'outsider@gmail.com', hd: undefined})), false);
    assert.deepEqual(f.writes, []);
    assert.equal(JSON.stringify(f.db.User.rows), before, 'denial must not normalize, link, or update the account');
  }
});

test('personal Google accounts with membership records retain their user IDs and roles', async () => {
  for (const role of ['student', 'ta', 'owner', 'dropped', 'guest', 'audit', 'grader', 'instructor']) {
    const f = fixture();
    f.db.User.rows.push({_id: id(1), googleemail: ' Roster.User+Tag@Gmail.COM '});
    f.db.CourseMember.rows.push({_id: id(2), studentId: id(1), courseId: id(3), role});
    const user = await f.verify(identity({email: 'roster.user+tag@gmail.com', hd: undefined}));
    assert.equal(String(user._id), String(id(1)), role);
    assert.equal(user.googleemail, 'roster.user+tag@gmail.com');
    assert.equal(user.googleid, 'synthetic-google-id');
    assert.equal(user.googletoken, undefined);
    assert.equal(f.db.User.rows.length, 1);
    assert.equal(f.db.CourseMember.rows[0].role, role, 'admission must not change course access');
    assert(f.writes.every(([model]) => model === 'User'));
  }
});

test('admitted legacy accounts normalize on login and resolve canonical student grades', async () => {
  for (const linked of [false, true]) {
    const course = courseFixture();
    const f = fixture({}, course);
    const email = ' Legacy.Student@Gmail.COM ';
    const normalizedEmail = 'legacy.student@gmail.com';
    const student = f.db.User.rows.find(row => String(row._id) === String(course.ids.student));
    student.googleemail = email;
    if (linked) student.googleid = 'synthetic-google-id';
    f.db.PostedGrades.rows.push({_id: id(800), courseId: course.ids.course, examId: course.ids.pset,
      email: normalizedEmail, name: 'Legacy Student', skillsMastered: ['F1'], skillsSkipped: []});
    const beforeGrades = JSON.stringify(f.db.PostedGrades.rows);
    const beforeMembers = JSON.stringify(f.db.CourseMember.rows);
    const user = await f.verify(identity({email: normalizedEmail, hd: undefined}));
    assert.equal(user.googleemail, normalizedEmail);
    assert.equal(user.id, String(course.ids.student));
    assert.equal(f.db.User.rows.find(row => String(row._id) === user.id).googleemail, normalizedEmail);
    assert.equal(user.googleid, 'synthetic-google-id');
    assert.deepEqual(f.writes, [['User', 'save']], 'both linked and unlinked legacy accounts save their normalized email');
    await f.verify(identity({email: normalizedEmail, hd: undefined}));
    assert.deepEqual(f.writes, [['User', 'save']], 'a later login needs no redundant save');
    await serve(course.app, async request => {
      const response = await request(`/showCourseToStudent/${course.ids.course}`, {user: user._id});
      assert.equal(response.status, 200);
      const view = await response.json();
      assert.equal(view.email, normalizedEmail);
      assert.equal(view.grades.length, 1);
      assert.equal(view.grades[0].email, normalizedEmail);
      assert.equal(view.grades[0].examId._id, String(course.ids.pset));
      assert.deepEqual(view.skillsMastered, ['F1']);
      assert.equal(view.skillCounts.F1, 1);
    });
    assert.equal(JSON.stringify(f.db.PostedGrades.rows), beforeGrades, 'login and grade reads never rewrite saved grades');
    assert.equal(JSON.stringify(f.db.CourseMember.rows), beforeMembers, 'normalization preserves memberships and roles');
  }
});

test('instructor record presence admits sign-in without changing approval status', async () => {
  for (const status of ['active', 'inactive', 'requested', 'denied']) {
    const f = fixture();
    f.db.User.rows.push({_id: id(1), googleemail: 'instructor@gmail.com', googleid: 'synthetic-google-id'});
    f.db.Instructor.rows.push({_id: id(2), userId: id(1), status});
    assert.equal(String((await f.verify(identity({email: 'instructor@gmail.com', hd: undefined})))._id), String(id(1)));
    assert.equal(f.db.Instructor.rows[0].status, status);
    assert.deepEqual(f.writes, [], 'already linked account needs no updates');
  }
});

test('ADMIN_EMAIL is normalized and can bootstrap without a User row; empty admin never bypasses', async () => {
  const f = fixture();
  assert.equal((await f.verify(identity({email: 'Admin@Example.Test', hd: undefined}))).googleemail, 'admin@example.test');
  for (const ADMIN_EMAIL of ['', ' ', undefined]) {
    const denied = fixture({ADMIN_EMAIL});
    assert.equal(await denied.verify(identity({email: 'admin@example.test', hd: undefined})), false);
    assert.deepEqual(denied.writes, []);
  }
});

test('roster, instructor and admin exceptions still require verified email', async () => {
  for (const kind of ['membership', 'instructor', 'admin']) {
    const f = fixture();
    const email = kind === 'admin' ? 'admin@example.test' : 'roster@gmail.com';
    f.db.User.rows.push({_id: id(1), googleemail: email});
    if (kind === 'membership') f.db.CourseMember.rows.push({studentId: id(1)});
    if (kind === 'instructor') f.db.Instructor.rows.push({userId: id(1)});
    assert.equal(await f.verify(identity({email, hd: undefined, email_verified: false})), false);
    assert.deepEqual(f.writes, []);
  }
});

test('membership and instructor records for other users cannot admit an outsider', async () => {
  const f = fixture();
  f.db.User.rows.push({_id: id(1), googleemail: 'outsider@gmail.com'});
  f.db.CourseMember.rows.push({studentId: id(2)});
  f.db.Instructor.rows.push({userId: id(3)});
  assert.equal(await f.verify(identity({email: 'outsider@gmail.com', hd: undefined})), false);
  assert.deepEqual(f.writes, []);
});

test('lookup and save failures reach Passport without crashes or successful authentication', async () => {
  const failure = new Error('synthetic database failure');
  for (const method of ['lookup', 'membership', 'instructor', 'save']) {
    const f = fixture();
    if (method === 'lookup') f.db.User.find = () => {throw failure;};
    if (method === 'membership' || method === 'instructor') {
      f.db.User.rows.push({_id: id(1), googleemail: 'outsider@gmail.com'});
      f.db[method === 'membership' ? 'CourseMember' : 'Instructor'].findOne = async () => {throw failure;};
    }
    if (method === 'save') f.db.User.prototype.save = async () => {throw failure;};
    await assert.rejects(f.verify(identity(method === 'membership' || method === 'instructor'
      ? {email: 'outsider@gmail.com', hd: undefined} : {})), error => error === failure);
    assert.deepEqual(f.writes, []);
  }
});

test('duplicate email records use only a unique matching Google subject and never merge', async () => {
  const f = fixture();
  f.db.User.rows.push(
    {_id: id(1), googleemail: ' New@Brandeis.edu '},
    {_id: id(2), googleemail: 'new@brandeis.edu', googleid: 'synthetic-google-id'},
  );
  f.db.CourseMember.rows.push({studentId: id(1), role: 'ta', courseId: id(3)},
    {studentId: id(2), role: 'ta', courseId: id(4)});
  const before = JSON.stringify(f.db.CourseMember.rows);
  assert.equal(String((await f.verify(identity()))._id), String(id(2)));
  assert.equal(JSON.stringify(f.db.CourseMember.rows), before);
  assert.deepEqual(f.writes, []);
  assert.equal(f.db.User.rows.length, 2);
  // Even if the unique subject is beyond the initial two email matches.
  f.db.User.rows.unshift({_id: id(5), googleemail: 'NEW@BRANDEIS.EDU'});
  assert.equal(String((await f.verify(identity()))._id), String(id(2)));
});

test('unlinked, mismatching, or multiply-linked email collisions deny without writes', async () => {
  for (const links of [[undefined, undefined], ['another-id', undefined],
    ['synthetic-google-id', 'synthetic-google-id']]) {
    const f = fixture();
    f.db.User.rows.push(
      {_id: id(1), googleemail: ' New@Brandeis.edu ', googleid: links[0]},
      {_id: id(2), googleemail: 'new@brandeis.edu', googleid: links[1]},
    );
    f.db.CourseMember.rows.push({studentId: id(1), role: 'ta'}, {studentId: id(2), role: 'ta'});
    const before = JSON.stringify(f.db.User.rows);
    assert.equal(await f.verify(identity()), false);
    assert.equal(JSON.stringify(f.db.User.rows), before);
    assert.deepEqual(f.writes, []);
  }
});

test('roster email regex metacharacters cannot match another identity', async () => {
  const f = fixture();
  f.db.User.rows.push({_id: id(1), googleemail: 'rosterXuser@gmail.com'});
  f.db.CourseMember.rows.push({studentId: id(1), role: 'student'});
  assert.equal(await f.verify(identity({email: 'roster.user@gmail.com', hd: undefined})), false);
  assert.deepEqual(f.writes, []);
});

const cookieOf = response => response.headers.get('set-cookie')?.split(';')[0];
async function begin(request) {
  const response = await request('/auth/google');
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get('location'));
  assert.equal(location.hostname, 'accounts.google.com');
  assert.deepEqual(location.searchParams.get('scope').split(' ').sort(), ['email', 'profile']);
  assert.equal(location.searchParams.has('hd'), false, 'personal roster accounts must reach Google');
  const state = location.searchParams.get('state');
  assert(state && state.length >= 24);
  return {state, cookie: cookieOf(response)};
}

test('OAuth state rejects missing, altered, cross-session and replayed callbacks before token exchange', async () => {
  for (const kind of ['missing', 'altered', 'cross-session', 'unsolicited']) {
    const f = fixture();
    f.setClaims(identity());
    await serve(f.app, async request => {
      const first = await begin(request);
      const second = await begin(request);
      const state = kind === 'missing' ? '' : kind === 'altered' ? 'wrong' : first.state;
      const cookie = kind === 'cross-session' ? second.cookie : kind === 'unsolicited' ? undefined : first.cookie;
      const response = await request(`/login/authorized?code=synthetic&state=${state}`, {headers: cookie ? {cookie} : {}});
      assert.equal(response.status, 302, kind);
      assert.equal(response.headers.get('location'), '/loginerror', kind);
      assert.equal(f.exchanges, 0);
      assert.deepEqual(f.writes, []);
    });
  }
  const f = fixture();
  f.setClaims(identity());
  await serve(f.app, async request => {
    const {state, cookie} = await begin(request);
    const url = `/login/authorized?code=synthetic&state=${state}`;
    const response = await request(url, {headers: {cookie}});
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/');
    const authenticatedCookie = cookieOf(response);
    const who = await request('/who', {headers: {cookie: authenticatedCookie}});
    assert.equal(who.status, 200, 'new session deserializes to the admitted user');
    assert.equal((await who.json()).id, String(f.db.User.rows[0]._id));
    const replay = await request(url, {headers: {cookie: authenticatedCookie}});
    assert.equal(replay.headers.get('location'), '/loginerror');
    assert.equal(f.exchanges, 1);
    assert.equal(f.db.User.rows.length, 1);
  });
});

test('real Passport callback denies outsiders and does not establish a login session', async () => {
  const f = fixture();
  f.setClaims(identity({email: 'outsider@gmail.com', hd: undefined}));
  await serve(f.app, async request => {
    const {state, cookie} = await begin(request);
    const response = await request(`/login/authorized?code=synthetic&state=${state}`, {headers: {cookie}});
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/loginerror');
    assert.equal((await request('/who', {headers: {cookie: cookieOf(response) || cookie}})).status, 401);
    assert.deepEqual(f.writes, []);
  });
});

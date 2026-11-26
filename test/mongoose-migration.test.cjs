const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const session = require('express-session');
const {Passport} = require('passport');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const {load} = require('./helpers/load.cjs');
const {fixture, serve} = require('./helpers/app.cjs');
const {id} = require('./helpers/models.cjs');

// Compile every production schema/plugin, but replace collection I/O only.
// Queries, ObjectId casting, document validation and saves use real Mongoose 8.
const fs = require('node:fs');
const path = require('node:path');
const modelDirectory = path.join(__dirname, '../models');
const realModels = Object.fromEntries(fs.readdirSync(modelDirectory).filter(file => file.endsWith('.js'))
  .map(file => [path.basename(file, '.js'), require(path.join(modelDirectory, file))]));

test('Google-only users retain the email index and leave hidden legacy password values untouched on save', async t => {
  const User = realModels.User;
  const stored = {_id: id(900), googleemail: ' Legacy@Brandeis.edu ',
    hash: 'synthetic-legacy-hash', salt: 'synthetic-legacy-salt', __v: 0};
  t.mock.method(User.collection, 'findOne', async (filter, options) => {
    assert.deepEqual(options.projection, {hash: 0, salt: 0});
    const {hash, salt, ...visible} = stored;
    return visible;
  });
  let updates = 0;
  t.mock.method(User.collection, 'updateOne', async (filter, update) => {
    updates++;
    assert.equal(update.$unset, undefined);
    assert.deepEqual(update.$set, {googleemail: 'legacy@brandeis.edu'});
    Object.assign(stored, update.$set);
    return {acknowledged: true, matchedCount: 1};
  });
  const user = await User.findById(stored._id);
  assert.equal(user.toObject().hash, undefined);
  assert.equal(user.toObject().salt, undefined);
  user.googleemail = 'legacy@brandeis.edu';
  await user.save();
  assert.equal(updates, 1);
  assert.equal(stored.hash, 'synthetic-legacy-hash');
  assert.equal(stored.salt, 'synthetic-legacy-salt');
  assert(User.schema.indexes().some(([keys, options]) => keys.googleemail === 1 && !options.unique));
  assert.equal(User.register, undefined);
  assert.equal(user.setPassword, undefined);
});

test('statistics and course totals execute real countDocuments queries with course filters', async t => {
  const f = fixture();
  const calls = [];
  const totals = {Course: 2, User: 5, Problem: 8, Answer: 13, Review: 3};
  for (const [name, total] of Object.entries(totals)) {
    const model = realModels[name];
    t.mock.method(model.collection, 'countDocuments', async filter => {
      calls.push([name, filter]);
      if (filter.courseId) {
        assert(filter.courseId instanceof mongoose.Types.ObjectId);
        assert.equal(String(filter.courseId), String(f.ids.course));
        return name === 'Answer' ? 7 : 4;
      }
      assert.deepEqual(filter, {});
      return total;
    });
    f.db[name].countDocuments = model.countDocuments.bind(model);
  }
  await serve(f.app, async request => {
    const response = await request('/stats', {user: f.ids.owner});
    assert.equal(response.status, 200);
    const stats = await response.json();
    for (const [name, total] of Object.entries(totals)) assert.equal(stats[name.toLowerCase() + 'Count'], total);
    const course = await request(`/showCourseToStudent/${f.ids.course}`, {user: f.ids.student});
    assert.equal(course.status, 200);
    assert.equal((await course.json()).AllAnswers, 7);
    const mastery = await request(`/showMastery_PRA/${f.ids.course}`, {user: f.ids.ta});
    assert.equal(mastery.status, 200);
    assert.equal((await mastery.json()).questions, 4);
  });
  assert.equal(calls.length, 7, 'all seven migrated count sites execute');
});

test('promoting a TA removes all prior roles only for that user in that course', async t => {
  const f = fixture();
  f.db.CourseMember.rows.push({_id: id(800), courseId: f.ids.course, studentId: f.ids.student, role: 'guest'},
    {_id: id(801), courseId: f.ids.otherCourse, studentId: f.ids.student, role: 'student'});
  const untouched = f.db.CourseMember.rows.filter(row =>
    String(row.courseId) !== String(f.ids.course) || String(row.studentId) !== String(f.ids.student));
  const before = JSON.stringify(untouched);
  let deletes = 0;
  t.mock.method(realModels.CourseMember.collection, 'deleteMany', async filter => {
    deletes++;
    assert(filter.courseId instanceof mongoose.Types.ObjectId);
    assert(filter.studentId instanceof mongoose.Types.ObjectId);
    assert.equal(String(filter.courseId), String(f.ids.course));
    assert.equal(String(filter.studentId), String(f.ids.student));
    let deletedCount = 0;
    for (let i = f.db.CourseMember.rows.length - 1; i >= 0; i--) {
      const row = f.db.CourseMember.rows[i];
      if (String(row.courseId) === String(filter.courseId) && String(row.studentId) === String(filter.studentId)) {
        f.db.CourseMember.rows.splice(i, 1);
        deletedCount++;
      }
    }
    return {acknowledged: true, deletedCount};
  });
  f.db.CourseMember.deleteMany = realModels.CourseMember.deleteMany.bind(realModels.CourseMember);
  await serve(f.app, async request => {
    const response = await request(`/addTA/${f.ids.course}`, {user: f.ids.owner, method: 'POST',
      body: new URLSearchParams({email: 'student@example.test', name: 'Synthetic TA', section: '2'}),
      headers: {'content-type': 'application/x-www-form-urlencoded'}});
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), `/showTAs/${f.ids.course}`);
  });
  assert.equal(deletes, 1);
  const memberships = f.db.CourseMember.rows.filter(row =>
    String(row.courseId) === String(f.ids.course) && String(row.studentId) === String(f.ids.student));
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0].role, 'ta');
  assert.equal(memberships[0].section, '2');
  assert.equal(JSON.stringify(f.db.CourseMember.rows.filter(row =>
    String(row.courseId) !== String(f.ids.course) || String(row.studentId) !== String(f.ids.student))), before);
});

function sessionCollection() {
  const rows = new Map();
  const indexes = [];
  return {rows, indexes,
    async createIndex(keys, options) {indexes.push({keys, options}); return 'expires_1';},
    async findOne(filter) {
      const row = rows.get(filter._id);
      return row && (!row.expires || row.expires > new Date()) ? {...row} : null;
    },
    async updateOne(filter, update, options) {
      const existing = rows.get(filter._id);
      if (existing || options.upsert) rows.set(filter._id, {...existing, ...update.$set});
      return {matchedCount: existing ? 1 : 0, upsertedCount: !existing && options.upsert ? 1 : 0};
    },
    async deleteOne(filter) {return {deletedCount: rows.delete(filter._id) ? 1 : 0};},
  };
}

test('real MongoStore preserves OAuth state, login, legacy sessions, expiry and logout across app instances', async t => {
  const User = realModels.User;
  const users = [];
  t.mock.method(User.collection, 'find', filter => ({toArray: async () => users.filter(row =>
    filter.googleemail.test(row.googleemail) && (!filter.googleid || row.googleid === filter.googleid))}));
  t.mock.method(User.collection, 'findOne', async filter => users.find(row => row._id.equals(filter._id)) || null);
  t.mock.method(User.collection, 'insertOne', async row => {
    users.push({...row}); return {acknowledged: true, insertedId: row._id};
  });
  const collection = sessionCollection();
  // A real driver client selects the URI database, but never connects to it.
  const client = new mongoose.mongo.MongoClient('mongodb://127.0.0.1:1/synthetic-mla');
  const database = client.db();
  t.mock.method(database, 'collection', name => {assert.equal(name, 'sessions'); return collection;});
  t.mock.method(client, 'db', name => {assert.equal(name, undefined); return database;});
  assert.equal(database.databaseName, 'synthetic-mla');
  let release;
  let connected = false;
  const ready = new Promise(resolve => {release = () => {connected = true; resolve();};});
  const stores = [];
  let connections = 0;
  function build() {
    const passport = new Passport();
    const configure = load('config/passport.js', {'../models/User': User, dotenv: {config() {}}},
      {process: {env: {CLIENT_ID: 'synthetic', CLIENT_SECRET: 'synthetic', CALLBACK_URL: 'http://localhost/login/authorized'}}});
    const authRouter = load('routes/authRouter.js', {passport, '../config/passport': configure});
    const strategy = passport._strategy('google');
    strategy._oauth2.getOAuthAccessToken = (code, params, done) => done(null, 'synthetic-token', undefined, {});
    strategy._oauth2.get = (url, token, done) => done(null, JSON.stringify({
      sub: 'synthetic-google-id', email: 'synthetic@brandeis.edu', email_verified: true,
      hd: 'brandeis.edu', name: 'Synthetic User',
    }));
    authRouter.get('/who', (req, res) => res.status(req.user ? 200 : 401).json({id: req.user?.id}));
    return fixture({env: {MONGODB_URL: 'mongodb://127.0.0.1:1/synthetic-mla'}, substitutes: {
      './routes/authRouter': authRouter,
      mongoose: {Types: mongoose.Types, connection: Object.assign(new EventEmitter(), {
        getClient() {assert(connected, 'store must wait for the connected client'); return client;},
      }), connect(uri, options) {
        connections++;
        assert.equal(uri, 'mongodb://127.0.0.1:1/synthetic-mla');
        assert.equal(JSON.stringify(options), JSON.stringify({family: 4}));
        return ready;
      }},
      'connect-mongo': {create(options) {const store = MongoStore.create(options); stores.push(store); return store;}},
    }}).app;
  }
  const firstApp = build();
  assert.equal(collection.indexes.length, 0);
  release();
  await stores[0].collectionP;
  assert.deepEqual(collection.indexes[0], {keys: {expires: 1}, options: {background: true, expireAfterSeconds: 0}});
  const cookieOf = response => response.headers.get('set-cookie')?.split(';')[0];
  let state, cookie;
  await serve(firstApp, async request => {
    assert.equal((await request('/login')).headers.get('set-cookie'), null, 'uninitialized sessions are not saved');
    const start = await request('/auth/google');
    assert.equal(start.status, 302);
    state = new URL(start.headers.get('location')).searchParams.get('state');
    cookie = cookieOf(start);
    assert(state && cookie);
  });
  let authenticatedCookie;
  await serve(build(), async request => {
    const response = await request(`/login/authorized?code=synthetic&state=${state}`, {headers: {cookie}});
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/');
    authenticatedCookie = cookieOf(response);
    assert(authenticatedCookie && authenticatedCookie !== cookie, 'Passport regenerates the session');
    assert.equal(users.length, 1, 'real Mongoose document save created the admitted user');
    assert.equal(users[0].googleemail, 'synthetic@brandeis.edu');
    const saved = [...collection.rows.values()].find(row => JSON.parse(row.session).passport?.user);
    assert(saved);
    assert.equal(JSON.parse(saved.session).passport.user, String(users[0]._id));
    assert(saved.expires > new Date(Date.now() + 23 * 60 * 60 * 1000), 'one-day cookie expiry is retained');
  });
  await serve(build(), async request => {
    const who = await request('/who', {headers: {cookie: authenticatedCookie}});
    assert.equal(who.status, 200);
    assert.equal((await who.json()).id, String(users[0]._id));
    const logout = await request('/logout', {headers: {cookie: authenticatedCookie}});
    assert.equal(logout.status, 302);
    assert.equal((await request('/who', {headers: {cookie: authenticatedCookie}})).status, 401);
    // v3's default unencrypted JSON shape and the existing cookie signature.
    const sid = 'synthetic-legacy-session';
    const expires = new Date(Date.now() + 60 * 60 * 1000);
    collection.rows.set(sid, {_id: sid, expires, session: JSON.stringify({
      cookie: {originalMaxAge: 86400000, expires, httpOnly: true, path: '/'}, passport: {user: String(users[0]._id)},
    })});
    const digest = require('node:crypto').createHmac('sha256', 'synthetic-test-secret')
      .update(sid).digest('base64').replace(/=+$/, '');
    const signature = sid + '.' + digest;
    const legacyCookie = 'connect.sid=' + encodeURIComponent('s:' + signature);
    assert.equal((await request('/who', {headers: {cookie: legacyCookie}})).status, 200);
    assert.equal((await request('/who', {headers: {cookie: legacyCookie + 'tampered'}})).status, 401);
    collection.rows.get(sid).expires = new Date(0);
    assert.equal((await request('/who', {headers: {cookie: legacyCookie}})).status, 401);
  });
  assert.equal(connections, 3, 'one shared Mongoose connection per app instance');
});

test('real query casting retains course constraints and rejects malformed ObjectIds before collection I/O', async t => {
  const Answer = realModels.Answer;
  const calls = [];
  t.mock.method(Answer.collection, 'findOne', async filter => {calls.push(filter); return null;});
  await Answer.findOne({courseId: String(id(1)), studentId: String(id(2)), pendingReviewers: String(id(3))});
  assert.equal(calls.length, 1);
  for (const field of ['courseId', 'studentId', 'pendingReviewers']) assert(calls[0][field] instanceof mongoose.Types.ObjectId);
  await assert.rejects(Answer.findOne({courseId: 'invalid-id'}), {name: 'CastError'});
  assert.equal(calls.length, 1);
  const query = Answer.findOne({courseId: String(id(1)), nonexistentField: 'synthetic'});
  assert.equal(query.cast().nonexistentField, 'synthetic', 'Mongoose 8 defaults do not silently strip unknown filters');
});

test('a rejected shared connection retains the fatal startup diagnostic and exit', () => {
  // Use a subprocess so an unhandled rejection cannot be hidden by a listener.
  const {spawnSync} = require('node:child_process');
  const result = spawnSync(process.execPath, ['-e', `
    const {EventEmitter} = require('node:events');
    const {fixture} = require('./test/helpers/app.cjs');
    const mongoose = require('mongoose');
    const MongoStore = require('connect-mongo');
    const f = fixture({
      exit(code) {process.stderr.write(f.errors.join('\\n')); process.exit(code);},
      substitutes: {
        mongoose: {Types: mongoose.Types, connection: new EventEmitter(),
          connect: () => Promise.reject(new Error('synthetic connection failure'))},
        'connect-mongo': MongoStore,
      },
    });
  `], {cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 5000});
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FATAL: could not connect to MongoDB: synthetic connection failure/);
  assert.doesNotMatch(result.stderr, /UnhandledPromiseRejection|TypeError|mongodb:\/\//);
});

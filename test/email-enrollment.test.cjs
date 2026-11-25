const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture, serve} = require('./helpers/app.cjs');
const {id} = require('./helpers/models.cjs');

const form = values => ({method: 'POST', body: new URLSearchParams(values),
  headers: {'content-type': 'application/x-www-form-urlencoded'}});

test('student lists normalize new addresses and reuse legacy users without duplicate accounts', async () => {
  const f = fixture();
  f.db.User.rows.push({_id: id(800), googleemail: ' Legacy.User+Tag@Gmail.COM '});
  await serve(f.app, async request => {
    const response = await request(`/addStudents/${f.ids.course}`, {user: f.ids.owner,
      ...form({emails: ' legacy.user+tag@gmail.com\nNEW@GMAIL.COM\n new@gmail.com \n\n'})});
    assert.equal(response.status, 302);
    assert(f.db.CourseMember.rows.some(row => String(row.studentId) === String(id(800))));
    assert.equal(f.db.User.rows.filter(row => row.googleemail === 'new@gmail.com').length, 1);
    assert.equal(f.db.User.rows.filter(row => row.googleemail.trim().toLowerCase() === 'legacy.user+tag@gmail.com').length, 1);
    assert.equal(f.db.User.rows.length, 7);
  });
});

test('TA and instructor additions reuse legacy emails and normalize newly created accounts', async () => {
  for (const kind of ['ta', 'instructor']) {
    const f = fixture();
    const adminId = id(801);
    f.db.User.rows.push({_id: adminId, googleemail: ' ADMIN@EXAMPLE.TEST '});
    f.db.User.rows.push({_id: id(800), googleemail: ' Legacy.User@Gmail.COM '});
    const url = kind === 'ta' ? `/addTA/${f.ids.course}` : '/addInstructor';
    const user = kind === 'ta' ? f.ids.owner : adminId;
    await serve(f.app, async request => {
      for (const email of ['legacy.user@gmail.com', ' NEW@GMAIL.COM ']) {
        const response = await request(url, {user, ...form({email, name: 'Synthetic Staff', section: '1'})});
        assert.equal(response.status, 302, await response.text());
      }
      const newUser = f.db.User.rows.find(row => row.googleemail === 'new@gmail.com');
      assert(newUser);
      const records = kind === 'ta' ? f.db.CourseMember.rows : f.db.Instructor.rows;
      const field = kind === 'ta' ? 'studentId' : 'userId';
      for (const expected of [id(800), newUser._id]) {
        assert(records.some(row => String(row[field]) === String(expected)), kind);
      }
      assert.equal(f.db.User.rows.filter(row => row.googleemail.trim().toLowerCase() === 'legacy.user@gmail.com').length, 1);
    });
  }
});

test('CSV roster loading reuses legacy identities and stores new addresses normalized', async () => {
  const f = fixture();
  f.db.User.rows.push({_id: id(800), googleemail: ' Legacy.User@Gmail.COM '});
  const csv = 'name,email,section\nLegacy,LEGACY.USER@GMAIL.COM,1\nNew, NEW@GMAIL.COM ,2\n';
  const body = new FormData();
  body.set('sections', new Blob([csv], {type: 'text/csv'}), 'synthetic-roster.csv');
  await serve(f.app, async request => {
    const response = await request(`/uploadRoster/${f.ids.course}`, {user: f.ids.owner, method: 'POST', body});
    assert.equal(response.status, 302, await response.text());
    const newUser = f.db.User.rows.find(row => row.googleemail === 'new@gmail.com');
    assert(newUser);
    assert(f.db.CourseMember.rows.some(row => String(row.studentId) === String(id(800)) && row.section === '1'));
    assert(f.db.CourseMember.rows.some(row => String(row.studentId) === String(newUser._id) && row.section === '2'));
    assert.equal(f.db.User.rows.filter(row => row.googleemail.trim().toLowerCase() === 'legacy.user@gmail.com').length, 1);
  });
});

test('roster edits stop on duplicate identities without granting arbitrary course roles', async () => {
  for (const kind of ['student', 'ta', 'instructor']) {
    const f = fixture();
    f.db.User.rows.push({_id: id(800), googleemail: 'Duplicate@Gmail.COM'},
      {_id: id(801), googleemail: 'duplicate@gmail.com'},
      {_id: id(802), googleemail: 'admin@example.test'});
    const url = kind === 'student' ? `/addStudents/${f.ids.course}` :
      kind === 'ta' ? `/addTA/${f.ids.course}` : '/addInstructor';
    await serve(f.app, async request => {
      const response = await request(url, {user: kind === 'instructor' ? id(802) : f.ids.owner,
        ...form({email: 'duplicate@gmail.com', emails: 'duplicate@gmail.com', name: 'Synthetic', section: '1'})});
      assert.equal(response.status, 409);
      assert.deepEqual(f.writes, []);
    });
  }
});

test('administrator comparisons normalize existing session emails and reject blank identities', async () => {
  const f = fixture();
  const response = {locals: {}, status() {return this;}, send() {this.denied = true;}};
  let called = false;
  await f.auth.isAdmin({user: {googleemail: ' ADMIN@EXAMPLE.TEST '}}, response, () => {called = true;});
  assert(called);
  assert.equal(response.locals.isAdmin, true);
  called = false;
  await f.auth.isAdmin({user: {googleemail: ''}}, response, () => {called = true;});
  assert.equal(called, false);
  assert.equal(response.denied, true);
});

test('ambiguous first CSV identity reports 409 before changing the existing roster', async () => {
  const f = fixture();
  f.db.User.rows.push({_id: id(800), googleemail: 'Duplicate@Gmail.COM'},
    {_id: id(801), googleemail: 'duplicate@gmail.com'});
  const before = JSON.stringify(f.db.CourseMember.rows);
  const body = new FormData();
  body.set('sections', new Blob(['name,email,section\nSynthetic,duplicate@gmail.com,1\n'], {type: 'text/csv'}), 'roster.csv');
  await serve(f.app, async request => {
    const response = await request(`/uploadRoster/${f.ids.course}`, {user: f.ids.owner, method: 'POST', body});
    assert.equal(response.status, 409);
    assert.deepEqual(f.writes, []);
    assert.equal(JSON.stringify(f.db.CourseMember.rows), before);
  });
});

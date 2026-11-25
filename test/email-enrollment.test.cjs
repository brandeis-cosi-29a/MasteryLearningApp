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

for (const [kind, email, expectedStatus] of [
  ['duplicate email', 'duplicate@gmail.com', 409],
  ['invalid email', 'not-an-email', 400],
]) {
  test(`later roster CSV row with ${kind} preserves absent students and TAs`, async () => {
    const f = fixture();
    f.db.User.rows.push({_id: id(800), googleemail: 'Duplicate@Gmail.COM'},
      {_id: id(801), googleemail: 'duplicate@gmail.com'});
    const preserved = f.db.CourseMember.rows.filter(row =>
      [String(f.ids.classmate), String(f.ids.ta)].includes(String(row.studentId)));
    const before = JSON.stringify(preserved);
    const body = new FormData();
    body.set('sections', new Blob([
      `name,email,section\nS1,student@example.test,Updated\nFailure,${email},1\n`,
    ], {type: 'text/csv'}), 'roster.csv');
    await serve(f.app, async request => {
      const response = await request(`/uploadRoster/${f.ids.course}`, {user: f.ids.owner, method: 'POST', body});
      assert.equal(response.status, expectedStatus);
      assert.equal(response.headers.get('location'), null, 'failed imports must not redirect to the roster');
      const after = f.db.CourseMember.rows.filter(row =>
        [String(f.ids.classmate), String(f.ids.ta)].includes(String(row.studentId)));
      assert.equal(JSON.stringify(after), before, 'S2 and the TA must remain untouched');
      assert(!f.writes.some(([model, action]) => model === 'CourseMember' && action === 'deleteMany'),
        'the final student-drop step must not run after a failed row');
    });
  });
}

test('student textarea stops at an invalid line after enrolling preceding valid addresses', async () => {
  const f = fixture();
  await serve(f.app, async request => {
    const response = await request(`/addStudents/${f.ids.course}`, {user: f.ids.owner,
      ...form({emails: 'good1@example.test\nnot-an-email\ngood2@example.test'})});
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('location'), null);
    const first = f.db.User.rows.find(row => row.googleemail === 'good1@example.test');
    assert(first, 'the preceding valid user was created');
    assert(f.db.CourseMember.rows.some(row => String(row.studentId) === String(first._id) &&
      String(row.courseId) === String(f.ids.course)), 'the preceding valid user was enrolled');
    assert(!f.db.User.rows.some(row => row.googleemail === 'not-an-email'));
    assert(!f.db.User.rows.some(row => row.googleemail === 'good2@example.test'));
  });
});

test('roster-created user resolves grades uploaded with a mixed-case padded CSV email', {timeout: 10000}, async () => {
  const f = fixture();
  // The existing grade-upload route redirects before finishing its import.
  // Wait for its final save instead of polling or assuming response timing.
  let imported;
  const finished = new Promise(resolve => {imported = resolve;});
  const save = f.db.ProblemSet.prototype.save;
  f.db.ProblemSet.prototype.save = async function () {
    const result = await save.call(this);
    imported();
    return result;
  };
  await serve(f.app, async request => {
    const rosterBody = new FormData();
    rosterBody.set('sections', new Blob(['name,email,section\nNew Student,NEW.STUDENT@EXAMPLE.TEST,1\n'],
      {type: 'text/csv'}), 'roster.csv');
    const roster = await request(`/uploadRoster/${f.ids.course}`, {user: f.ids.owner, method: 'POST', body: rosterBody});
    assert.equal(roster.status, 302);
    const student = f.db.User.rows.find(row => row.googleemail === 'new.student@example.test');
    assert(student);
    const body = new FormData();
    body.set('psetId', String(f.ids.pset));
    body.set('grades', new Blob(['name,email,F1\nNew Student, New.Student@Example.Test ,1\n'],
      {type: 'text/csv'}), 'grades.csv');
    const upload = await request(`/uploadGrades/${f.ids.course}`, {user: f.ids.owner, method: 'POST', body});
    assert.equal(upload.status, 302);
    await finished;
    assert.equal(f.db.PostedGrades.rows.length, 1);
    assert.equal(f.db.PostedGrades.rows[0].email, student.googleemail);
    const response = await request(`/showCourseToStudent/${f.ids.course}`, {user: student._id});
    assert.equal(response.status, 200);
    const view = await response.json();
    assert.equal(view.grades.length, 1);
    assert.equal(view.grades[0].email, student.googleemail);
    assert.deepEqual(view.skillsMastered, ['F1']);
    assert.equal(view.skillCounts.F1, 1);
  });
});

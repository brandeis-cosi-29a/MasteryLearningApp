const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture, serve} = require('./helpers/app.cjs');
const {id} = require('./helpers/models.cjs');

test('unapproved owners block existing grants, uploads, and shared material without changing records', async () => {
  for (const status of [undefined, 'requested', 'inactive', 'denied']) {
    const {app, db, ids, writes, uploads, imageReads} = fixture();
    if (status) db.Instructor.rows[0].status = status;
    else db.Instructor.rows.length = 0;
    const before = JSON.stringify(db.CourseMember.rows);
    await serve(app, async request => {
      for (const user of [ids.owner, ids.ta, ids.student, ids.classmate]) {
        assert.equal((await request(`/showCourse/${ids.course}`, {user})).status, 403);
      }
      assert.equal((await request(`/answerImage/${ids.course}/${ids.answer}`, {user: ids.classmate})).status, 403);
      assert.equal((await request(`/uploadAnswerPhoto/${ids.course}/${ids.pset}/${ids.problem}?theStudentId=${ids.classmate}`, {
        user: ids.ta, method: 'POST',
      })).status, 403);
      assert.equal((await request(`/saveReview2/${ids.course}/${ids.pset}/${ids.problem}/${ids.answer}`, {
        user: ids.ta, method: 'POST',
      })).status, 403);
      // An approved instructor who is a TA cannot bypass its actual owner's status.
      db.Instructor.rows.push({_id: id(901), userId: ids.ta, status: 'active'});
      assert.equal((await request(`/showCourse/${ids.course}`, {user: ids.ta})).status, 403);
      db.Instructor.rows.push({_id: id(902), userId: ids.owner, status: 'active'});
      for (const user of [ids.owner, ids.ta, ids.student]) {
        assert.equal((await request(`/showCourse/${ids.course}`, {user})).status, 302);
      }
      // Revoke between requests using the same authenticated test identity.
      db.Instructor.rows.at(-1).status = 'inactive';
      assert.equal((await request(`/showCourse/${ids.course}`, {user: ids.student})).status, 403);
    });
    assert.equal(writes.length, 0);
    assert.equal(uploads.length, 0);
    assert.equal(imageReads.length, 0);
    assert.equal(JSON.stringify(db.CourseMember.rows), before);
  }
});

test('administrators retain recovery while object relationships remain enforced', async () => {
  const {app, db, ids, writes} = fixture();
  db.Instructor.rows.length = 0;
  db.User.rows.find(user => String(user._id) === String(ids.outsider)).googleemail = 'admin@example.test';
  await serve(app, async request => {
    assert.equal((await request(`/showCourse/${ids.course}`, {user: ids.outsider})).status, 302);
    assert.equal((await request(`/getGradesAsJSON/${ids.course}`, {user: ids.outsider})).status, 200);
    assert.equal((await request(`/showReviewsOfAnswer/${ids.course}/${ids.pset}/${ids.otherAnswer}`, {user: ids.outsider})).status, 404);
    assert.equal((await request(`/instructors`, {user: ids.outsider})).status, 200);
    db.Course.rows[0].ownerId = undefined;
    assert.equal((await request(`/showCourse/${ids.course}`, {user: ids.ta})).status, 403);
    assert.equal((await request(`/showCourse/${ids.course}`, {user: ids.outsider})).status, 302);
  });
  assert.equal(writes.length, 0);
});

test('an unapproved source bank cannot be listed, previewed, or imported through an approved destination', async () => {
  const {app, db, ids, writes} = fixture();
  db.Course.rows[1].ownerId = ids.outsider;
  db.Course.rows[1].name = 'Synthetic shared bank';
  db.Course.rows[1].guestAccess = 'instructors';
  await serve(app, async request => {
    const list = await request(`/importSkills/${ids.course}`, {user: ids.owner});
    assert.equal(list.status, 200);
    assert(!(await list.text()).includes('Synthetic shared bank'));
    for (const url of [
      `/showSkillsToImport/${ids.course}/${ids.otherCourse}`,
      `/importAllSkills/${ids.course}/${ids.otherCourse}`,
      `/previewLibraryProblem/${ids.course}/${ids.pset}/${ids.otherProblem}`,
      `/addProblemToPset/${ids.course}/${ids.pset}/${ids.otherProblem}/${ids.skill}`,
    ]) assert.equal((await request(url, {user: ids.owner})).status, 404);
    db.Instructor.rows.push({_id: id(903), userId: ids.outsider, status: 'active'});
    assert.equal((await request(`/previewLibraryProblem/${ids.course}/${ids.pset}/${ids.otherProblem}`, {user: ids.owner})).status, 200);
  });
  assert.equal(writes.length, 0);
});

test('a course lock isolates one course, overrides approval, and remains reversible', async () => {
  const {app, db, ids, writes, uploads, imageReads} = fixture();
  db.User.rows.find(user => String(user._id) === String(ids.outsider)).googleemail = 'admin@example.test';
  db.Course.rows[0].accessDisabled = true;
  const before = JSON.stringify(db.CourseMember.rows);
  await serve(app, async request => {
    for (const user of [ids.owner, ids.ta, ids.student, ids.classmate]) {
      assert.equal((await request(`/showCourse/${ids.course}`, {user})).status, 403);
    }
    assert.equal((await request(`/answerImage/${ids.course}/${ids.answer}`, {user: ids.classmate})).status, 403);
    assert.equal((await request(`/uploadAnswerPhoto/${ids.course}/${ids.pset}/${ids.problem}`, {user: ids.student, method: 'POST'})).status, 403);
    assert.equal((await request(`/showCourse/${ids.otherCourse}`, {user: ids.owner})).status, 302);
    assert.equal((await request(`/showCourse/${ids.course}`, {user: ids.outsider})).status, 302);
    db.Course.rows[0].accessDisabled = false;
    assert.equal((await request(`/showCourse/${ids.course}`, {user: ids.student})).status, 302);
    db.Course.rows[0].active = false;
    assert.equal((await request(`/showCourse/${ids.course}`, {user: ids.student})).status, 302, 'archive alone does not revoke');
    db.Course.rows[0].accessDisabled = true;
    assert.equal((await request(`/showCourse/${ids.course}`, {user: ids.student})).status, 403);
  });
  assert.equal(writes.length, 0);
  assert.equal(uploads.length, 0);
  assert.equal(imageReads.length, 0);
  assert.equal(JSON.stringify(db.CourseMember.rows), before);
});

test('a locked source bank stays unavailable to imports even with an approved owner', async () => {
  const {app, db, ids, writes} = fixture();
  db.Course.rows[1].guestAccess = 'instructors';
  db.Course.rows[1].name = 'Locked synthetic bank';
  db.Course.rows[1].accessDisabled = true;
  await serve(app, async request => {
    const list = await request(`/importSkills/${ids.course}`, {user: ids.owner});
    assert.equal(list.status, 200);
    assert(!(await list.text()).includes('Locked synthetic bank'));
    for (const url of [
      `/showSkillsToImport/${ids.course}/${ids.otherCourse}`,
      `/importAllSkills/${ids.course}/${ids.otherCourse}`,
      `/previewLibraryProblem/${ids.course}/${ids.pset}/${ids.otherProblem}`,
      `/addProblemToPset/${ids.course}/${ids.pset}/${ids.otherProblem}/${ids.skill}`,
    ]) assert.equal((await request(url, {user: ids.owner})).status, 404);
    assert.equal((await request(`/showProblem/${ids.course}/${ids.pset}/${ids.problem}`, {user: ids.owner})).status, 200, 'destination material stays available');
    db.Course.rows[1].accessDisabled = false;
    assert.equal((await request(`/previewLibraryProblem/${ids.course}/${ids.pset}/${ids.otherProblem}`, {user: ids.owner})).status, 200);
  });
  assert.equal(writes.length, 0);
});

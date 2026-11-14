const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture, serve} = require('./helpers/app.cjs');
const {id} = require('./helpers/models.cjs');

test('separate shared problem bank supports skill import, library search, preview and problem copy', async () => {
  const {app, db, ids} = fixture({realViews: true});
  db.Course.rows[0].name = 'COSI 29A';
  db.Course.rows[1].name = 'Discrete Math Problem Bank';
  db.Course.rows[1].ownerId = ids.outsider;
  db.Instructor.rows.push({_id: id(301), userId: ids.outsider, status: 'active'});
  db.Course.rows[1].guestAccess = 'instructors';
  db.Problem.rows[1].createdAt = new Date();
  db.Problem.rows[1].pendingReviews = [{answerId: ids.otherAnswer, reviewerId: ids.outsider}];
  await serve(app, async request => {
    const imported = await request(`/importAllSkills/${ids.course}/${ids.otherCourse}`, {user: ids.owner});
    assert.equal(imported.status, 302);
    const skill = db.Skill.rows.find(skill => String(skill.original) === String(ids.otherSkill));
    assert(skill);
    assert.equal(String(skill.courseId), String(ids.course));
    assert(db.CourseSkill.rows.some(link => String(link.skillId) === String(skill._id)));
    const library = await request(`/showProblemsBySkill/${ids.course}/${ids.pset}/${skill._id}`, {user: ids.owner});
    const libraryHtml = await library.text();
    assert.equal(library.status, 200, libraryHtml);
    assert.match(libraryHtml, /Discrete Math Problem Bank/);
    assert.match(libraryHtml, new RegExp(`/previewLibraryProblem/${ids.course}/${ids.pset}/${ids.otherProblem}`));
    const previewUrl = `/previewLibraryProblem/${ids.course}/${ids.pset}/${ids.otherProblem}`;
    const preview = await request(previewUrl, {user: ids.owner});
    const previewHtml = await preview.text();
    assert.equal(preview.status, 200, previewHtml);
    assert.match(previewHtml, /question/);
    assert(!previewHtml.includes(String(ids.otherAnswer)));
    assert(!previewHtml.includes('protected feedback'));
    assert.equal((await request(`/addProblemToPset/${ids.course}/${ids.pset}/${ids.otherProblem}/${skill._id}`, {user: ids.owner})).status, 302);
    const copy = db.Problem.rows.find(problem => String(problem.parentProblemId) === String(ids.otherProblem));
    assert(copy);
    assert.equal(String(copy.courseId), String(ids.course));
    assert.equal(String(copy.psetId), String(ids.pset));
    assert.equal(copy.visible, db.Problem.rows[1].visible, 'retain existing import availability behavior');
    assert.equal(copy.pendingReviews.length, 0);
    assert.equal(db.Problem.rows[1].pendingReviews.length, 1, 'source state is unchanged');
    assert.equal((await request(`/showReviewsOfAnswer/${ids.course}/${ids.pset}/${ids.otherAnswer}`, {user: ids.owner})).status, 404);
    assert.equal((await request(previewUrl, {user: ids.student})).status, 403);
    db.Course.rows[1].guestAccess = 'none';
    assert.equal((await request(previewUrl, {user: ids.owner})).status, 404);
    assert.equal((await request(`/importAllSkills/${ids.course}/${ids.otherCourse}`, {user: ids.owner})).status, 404);
  });
});

test('students retain own feedback, regrades and protected image links', async () => {
  const {app, db, ids} = fixture({realViews: true});
  db.Answer.rows[0].officialReviewId = ids.review;
  await serve(app, async request => {
    const response = await request(`/showReviewsOfAnswer/${ids.course}/${ids.pset}/${ids.answer}`, {user: ids.classmate});
    const html = await response.text();
    assert.equal(response.status, 200, html);
    assert.match(html, /protected feedback/);
    assert.match(html, new RegExp(`/answerImage/${ids.course}/${ids.answer}`));
    assert(!html.includes('.amazonaws.com/studentImages/'));
    const regrade = await request(`/requestRegrade/${ids.course}/${ids.review}`, {user: ids.classmate,
      method: 'POST', body: 'reason=Please+recheck', headers: {'content-type': 'application/x-www-form-urlencoded'}});
    assert.equal(regrade.status, 302);
    assert(db.RegradeRequest.rows.some(row => row.reason === 'Please recheck'));
    assert.equal((await request(`/showOneStudentInfo/${ids.course}/${ids.classmate}`, {user: ids.student})).status, 403);
  });
});

test('staff retain same-course JSON/CSV exports and roster access', async () => {
  const {app, db, ids} = fixture();
  db.PostedGrades.rows.push({_id: id(900), courseId: ids.course, examId: ids.pset,
    email: 'classmate@example.test', name: 'Classmate', skillsMastered: ['F1'], skillsSkipped: []});
  await serve(app, async request => {
    const grades = await request(`/getGradesAsJSON/${ids.course}`, {user: ids.ta});
    assert.equal(grades.status, 200);
    assert.equal((await grades.json())[0].email, 'classmate@example.test');
    assert.equal((await request(`/showRoster/${ids.course}`, {user: ids.ta})).status, 200);
    assert.equal((await request(`/showMastery/${ids.course}?csv=true`, {user: ids.ta})).status, 200);
    assert.equal((await request(`/getGradesAsJSON/${ids.course}`, {user: ids.student})).status, 403);
    assert.equal((await request(`/showRoster/${ids.course}`, {user: ids.student})).status, 403);
  });
});

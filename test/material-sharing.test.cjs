const test = require('node:test');
const assert = require('node:assert/strict');
const {load} = require('./helpers/load.cjs');
const {models, id} = require('./helpers/models.cjs');

test('source sharing permits material imports without copying student review state', async () => {
  const {db} = models();
  const substitutes = Object.fromEntries(Object.entries(db).map(([name, model]) => [`../models/${name}`, model]));
  const owners = load('routes/courseOwnerAccess.js', substitutes);
  const access = load('routes/materialAccess.js', {...substitutes, './courseOwnerAccess': owners});
  const owner = id(1), other = id(2), source = id(3), pset = id(4), problem = id(5);
  db.Instructor.rows.push({userId: owner, status: 'active'}, {userId: other, status: 'active'});
  db.Course.rows.push({_id: source, ownerId: other, guestAccess: 'none'});
  db.ProblemSet.rows.push({_id: pset, courseId: source});
  db.Problem.rows.push({_id: problem, courseId: source, psetId: pset, problemText: 'Bank question', rubric: 'Bank rubric', visible: true, peerReviewable: false, pendingReviews: [{answerId: id(9), reviewerId: id(10)}]});
  const request = {params: {sourceProblemId: String(problem)}, user: {_id: owner}};
  const invoke = req => new Promise(resolve => access.requireMaterialSource(req, {}, err => resolve(err)));
  assert.equal((await invoke(request)).status, 404, 'private source denied');
  for (const sharing of ['instructors', 'all']) {
    db.Course.rows[0].guestAccess = sharing;
    assert.equal(await invoke(request), undefined);
    assert.equal(request.sourceProblem.pendingReviews, undefined, 'material projection excludes source assignments');
    const copy = access.copyProblemMaterial(request.sourceProblem, {courseId: id(20), psetId: id(21), skillId: id(22)});
    assert.equal(String(copy.courseId), String(id(20)));
    assert.equal(String(copy.parentProblemId), String(problem));
    assert.equal(copy.problemText, 'Bank question');
    assert.equal(copy.rubric, 'Bank rubric');
    assert.equal(copy.pendingReviews.length, 0);
    assert.equal(copy.visible, true);
    assert.equal(copy.peerReviewable, false);
  }
  db.Course.rows[0].guestAccess = 'none';
  db.Course.rows[0].ownerId = owner;
  assert.equal(await invoke(request), undefined, 'instructor can reuse own private material');
  db.ProblemSet.rows[0].courseId = id(99);
  assert.equal((await invoke(request)).status, 404, 'inconsistent source parent denied');
  assert.equal((await invoke({...request, params: {sourceProblemId: {$ne: null}}})).status, 404);
});

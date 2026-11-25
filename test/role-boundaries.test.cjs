const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture, serve} = require('./helpers/app.cjs');
const {id} = require('./helpers/models.cjs');

// Matches ADMIN_EMAIL in test/helpers/load.cjs.
const ADMIN_EMAIL = 'admin@example.test';
const OWNER_DENIED = 'Only the owner has access to this page.';
const INSTRUCTOR_DENIED = 'Only approved instructors have access to this page.';

// Every course route that requires the course owner. Pinned on purpose: dropping
// isOwner from one of these, or adding an owner-only route, must be a visible
// change to this list. Entries marked `instructor` also require an approved
// Instructor record (problem library and skill import).
const OWNER_ROUTES = [
  'GET /setActive/:courseId/:value', 'GET /dumpStats/:courseId', 'POST /addStudents/:courseId',
  'GET /editCourse/:courseId', 'POST /editCourse/:courseId',
  'GET /editSupportFiles/:courseId', 'POST /editSupportFiles/:courseId',
  'GET /addSkill/:courseId', 'POST /addSkill/:courseId', 'GET /removeSkill/:courseId/:skillId',
  'GET /editSkill/:courseId/:skillId', 'POST /editSkill/:courseId/:skillId',
  'GET /importSkills/:courseId instructor', 'GET /showSkillsToImport/:courseId/:otherCourseId instructor',
  'GET /importAllSkills/:courseId/:otherCourseId instructor',
  'GET /addProblemSet/:courseId', 'POST /saveProblemSet/:courseId',
  'GET /editProblemSet/:courseId/:psetId', 'POST /updateProblemSet/:courseId/:psetId',
  'POST /uploadProblems/:courseId/:psetId', 'POST /setAsMakeup/:courseId/:psetId',
  'POST /updatePsetStatus/:courseId/:psetId', 'GET /updatePsetStatus/:courseId/:psetId/:status',
  'GET /addProblem_PRA/:courseId/:psetId', 'GET /addProblem/:courseId/:psetId',
  'POST /saveProblem_PRA/:courseId/:psetId', 'POST /saveProblem/:courseId/:psetId',
  'POST /updateProblem/:courseId/:probId', 'GET /startProblem/:courseId/:probId',
  'GET /stopProblem/:courseId/:probId',
  'GET /showProblemLibrary/:courseId/:psetId instructor',
  'GET /showProblemsBySkill/:courseId/:psetId/:skillId instructor',
  'GET /previewLibraryProblem/:courseId/:psetId/:sourceProblemId instructor',
  'GET /addProblemToPset/:courseId/:psetId/:sourceProblemId/:skillId instructor',
  'GET /removeProblem/:courseId/:psetId/:probId', 'GET /editProblem/:courseId/:probId',
  'POST /addTA/:courseId', 'POST /removeTAs/:courseId', 'GET /mastery2/:courseId',
].map(entry => {
  const [method, path, flag] = entry.split(' ');
  return {method, path, instructor: flag === 'instructor'};
});

const OWN = {courseId: 'course', psetId: 'pset', probId: 'problem', skillId: 'skill',
  sourceProblemId: 'otherProblem', otherCourseId: 'otherCourse'};

function mountedRoutes(app) {
  return app._router.stack.flatMap(layer => layer.route ? [layer.route] : layer.handle.stack?.filter(x => x.route).map(x => x.route) || []);
}

function urlFor(path, ids) {
  return path.replace(/:([A-Za-z]+)/g, (_, key) => String(ids[OWN[key]] || 'test'));
}

// Role setups applied to a fresh fixture. Each returns the user to send as.
const ROLES = {
  owner: ({ids}) => ids.owner,
  ta: ({ids}) => ids.ta,
  student: ({ids}) => ids.student,
  'student with an Instructor record': ({db, ids}) => {
    db.Instructor.rows.push({_id: id(301), userId: ids.student, status: 'active'});
    return ids.student;
  },
  'TA with an Instructor record': ({db, ids}) => {
    db.Instructor.rows.push({_id: id(302), userId: ids.ta, status: 'active'});
    // Not the source course's owner, so import needs a course shared with instructors.
    db.Course.rows[1].guestAccess = 'instructors';
    return ids.ta;
  },
  admin: ({db}) => {
    db.User.rows.push({_id: id(400), googleemail: ADMIN_EMAIL, googlename: 'admin'});
    return id(400);
  },
  'admin with an Instructor record': ({db}) => {
    db.User.rows.push({_id: id(400), googleemail: ADMIN_EMAIL, googlename: 'admin'});
    db.Instructor.rows.push({_id: id(303), userId: id(400), status: 'active'});
    // Admin rights do not extend to unshared source courses (see the admin test).
    db.Course.rows[1].guestAccess = 'instructors';
    return id(400);
  },
  'admin with an Instructor record, source course not shared': ({db}) => {
    db.User.rows.push({_id: id(400), googleemail: ADMIN_EMAIL, googlename: 'admin'});
    db.Instructor.rows.push({_id: id(303), userId: id(400), status: 'active'});
    return id(400);
  },
};

// Sends one request as `role` on a fresh fixture, so earlier requests' writes
// (removed skills, inactive courses...) cannot change the outcome.
async function requestAs(role, route) {
  const f = fixture();
  // /mastery2 runs an aggregation; the simulated models have none, and only
  // whether the request gets past the owner check matters here.
  f.db.Answer.aggregate = async () => [];
  const user = ROLES[role](f);
  let status, text;
  await serve(f.app, async request => {
    const response = await request(urlFor(route.path, f.ids), {user, method: route.method});
    status = response.status;
    text = await response.text();
  });
  return {status, text, writes: f.writes.length, uploads: f.uploads.length};
}

test('the owner-only route list matches what is mounted', () => {
  const {app, auth} = fixture();
  const mounted = mountedRoutes(app)
    .filter(route => route.path.includes(':courseId') && route.stack.some(layer => layer.handle === auth.isOwner))
    .map(route => {
      const instructor = route.stack.some(layer => layer.handle === auth.isInstructor);
      return `${Object.keys(route.methods)[0].toUpperCase()} ${route.path}${instructor ? ' instructor' : ''}`;
    }).sort();
  const pinned = OWNER_ROUTES.map(r => `${r.method} ${r.path}${r.instructor ? ' instructor' : ''}`).sort();
  assert.deepEqual(mounted, pinned);
});

test('TAs and students, even approved instructors enrolled as students, cannot use owner-only routes', async () => {
  for (const role of ['ta', 'student', 'student with an Instructor record']) {
    for (const route of OWNER_ROUTES) {
      const result = await requestAs(role, route);
      const label = `${role}: ${route.method} ${route.path}`;
      assert.equal(result.status, 403, label);
      assert.equal(result.text, OWNER_DENIED, label);
      assert.equal(result.writes, 0, `${label} wrote to the database`);
      assert.equal(result.uploads, 0, `${label} uploaded a file`);
    }
  }
});

test('owners, approved-instructor TAs and the admin get past the owner check', async () => {
  for (const role of ['owner', 'TA with an Instructor record', 'admin with an Instructor record', 'admin']) {
    for (const route of OWNER_ROUTES) {
      // The admin without an Instructor record is covered by the next test.
      if (role === 'admin' && route.instructor) continue;
      const result = await requestAs(role, route);
      const label = `${role}: ${route.method} ${route.path}`;
      assert.notEqual(result.status, 403, `${label}: ${result.text}`);
      assert.notEqual(result.status, 404, `${label}: route fixture did not resolve`);
    }
  }
});

test('the admin needs an Instructor record, and a shared source, for the problem library and skill import', async () => {
  // Deliberate policy: admin access alone must not grant the shared problem
  // library, so admin rights can be handed over without it.
  const libraryRoutes = OWNER_ROUTES.filter(route => route.instructor);
  assert.equal(libraryRoutes.length, 7);
  for (const route of libraryRoutes) {
    const result = await requestAs('admin', route);
    const label = `admin: ${route.method} ${route.path}`;
    assert.equal(result.status, 403, label);
    assert.equal(result.text, INSTRUCTOR_DENIED, label);
    assert.equal(result.writes, 0, label);
  }
  // With an Instructor record, the admin is treated like any other instructor:
  // a source course it does not own must be shared with instructors.
  for (const route of libraryRoutes.filter(route => /:(otherCourseId|sourceProblemId)\b/.test(route.path))) {
    const result = await requestAs('admin with an Instructor record, source course not shared', route);
    assert.equal(result.status, 404, `admin, unshared source: ${route.method} ${route.path}`);
    assert.equal(result.writes, 0);
  }
});

test('review votes are limited to staff, the answer author and the reviewer, voting as themselves', async () => {
  for (const vote of ['thumbsU', 'thumbsD']) {
    const voters = vote === 'thumbsU' ? 'upvoters' : 'downvoters';
    const {app, db, ids} = fixture();
    // Saving replaces the stored row, so look it up fresh each time.
    const stored = () => db.Review.rows.find(r => String(r._id) === String(ids.review));
    await serve(app, async request => {
      const cast = (user, mode, urlUser = user) =>
        request(`/${vote}/${ids.course}/${mode}/${ids.review}/${urlUser}`, {user});

      // An enrolled student unrelated to the review is refused on both modes.
      for (const mode of ['select', 'deselect']) assert.equal((await cast(ids.student, mode)).status, 403, `${vote} ${mode} by unrelated student`);
      assert.deepEqual(stored()[voters], []);

      // The answer author (classmate), the reviewer (ta) and staff (owner) may vote.
      for (const user of [ids.classmate, ids.ta, ids.owner]) assert.equal((await cast(user, 'select')).status, 200, `${vote} by ${user}`);
      assert.deepEqual(stored()[voters].map(String).sort(), [ids.classmate, ids.ta, ids.owner].map(String).sort());

      // A :userId naming someone else is refused outright, so nobody can vote,
      // or withdraw a vote, on another user's behalf.
      for (const mode of ['select', 'deselect']) assert.equal((await cast(ids.classmate, mode, ids.owner)).status, 403, `${vote} ${mode} with forged userId`);
      assert.deepEqual(stored()[voters].map(String).sort(), [ids.classmate, ids.ta, ids.owner].map(String).sort());

      // Withdrawing removes only the signed-in user's vote.
      assert.equal((await cast(ids.classmate, 'deselect')).status, 200);
      assert.deepEqual(stored()[voters].map(String).sort(), [ids.ta, ids.owner].map(String).sort());
    });
  }
});

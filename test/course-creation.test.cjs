const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const {load, ROOT} = require('./helpers/load.cjs');

test('direct course creation requires active instructor approval before writes', async () => {
  let approval;
  let writes = 0;
  const auth = load('routes/authFunctions.js', {
    '../models/Instructor': {findOne: async q => approval?.status === q.status ? approval : null},
    '../models/CourseMember': {findOne: async () => null},
    '../models/Course': {},
    './courseScope': {},
  });
  class Course {
    constructor(data) {Object.assign(this, data); this._id = 'new-course';}
    async save() {writes++; return this;}
  }
  class Document {async save() {writes++;}}
  const app = express();
  app.use(express.urlencoded({extended: false}));
  app.use((req, res, next) => {
    if (req.headers['x-test-login']) req.user = {_id: 'user', googleemail: 'person@gmail.com'};
    req.isAuthenticated = () => !!req.user;
    next();
  });
  const source = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const start = source.indexOf('app.get("/createCourse"');
  const end = source.indexOf('async function getCoursePin()', start);
  vm.runInNewContext(source.slice(start, end), {
    app, ...auth, Course, CourseMember: Document, SupportFile: Document,
    getCoursePin: async () => 1234567, path, __dirname: ROOT,
    fsPromises: {readFile: async () => 'test template'},
  });
  app.use((err, req, res, next) => res.status(500).send('Unexpected error'));
  const server = await new Promise(resolve => {const s = app.listen(0, '127.0.0.1', () => resolve(s));});
  try {
    const send = loggedIn => fetch(`http://127.0.0.1:${server.address().port}/createNewCourse`, {
      method: 'POST', redirect: 'manual',
      headers: {'content-type': 'application/x-www-form-urlencoded', ...(loggedIn ? {'x-test-login': 'yes'} : {})},
      body: 'courseName=Test&norobot=on',
    });
    assert.equal((await send(false)).status, 302);
    for (const status of [undefined, 'requested', 'inactive', 'denied']) {
      approval = status ? {status} : undefined;
      assert.equal((await send(true)).status, 403);
      assert.equal(writes, 0);
    }
    approval = {status: 'active'};
    const allowed = await send(true);
    assert.equal(allowed.status, 302);
    assert.equal(allowed.headers.get('location'), '/showCourseToStaff/new-course');
    assert.equal(writes, 4, 'course, owner membership, and two support files');
  } finally {await new Promise(resolve => server.close(resolve));}
});

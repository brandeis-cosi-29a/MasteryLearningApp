const express = require('express');
const session = require('express-session');
const {EventEmitter} = require('node:events');
const {Types} = require('mongoose');
const {load} = require('./load.cjs');
const {models, id} = require('./models.cjs');

function fixture(options = {}) {
  const {db, writes} = models();
  const ids = Object.fromEntries(['owner', 'ta', 'student', 'classmate', 'outsider', 'course', 'otherCourse', 'pset', 'otherPset', 'problem', 'otherProblem', 'answer', 'otherAnswer', 'review', 'otherReview', 'request', 'otherRequest', 'skill', 'otherSkill'].map((key, i) => [key, id(i + 1)]));
  for (const key of ['owner', 'ta', 'student', 'classmate', 'outsider']) db.User.rows.push({_id: ids[key], googleemail: `${key}@example.test`, googlename: key});
  for (const [course, pset, problem, answer, review, request, skill] of [
    ['course', 'pset', 'problem', 'answer', 'review', 'request', 'skill'],
    ['otherCourse', 'otherPset', 'otherProblem', 'otherAnswer', 'otherReview', 'otherRequest', 'otherSkill'],
  ]) {
    db.Course.rows.push({_id: ids[course], ownerId: ids.owner, courseType: 'mla1', guestAccess: 'none', active: true});
    db.ProblemSet.rows.push({_id: ids[pset], courseId: ids[course], status: 'released', name: pset});
    db.Skill.rows.push({_id: ids[skill], courseId: ids[course], shortName: 'F1', name: skill});
    db.CourseSkill.rows.push({_id: id(100 + db.CourseSkill.rows.length), courseId: ids[course], skillId: ids[skill]});
    db.Problem.rows.push({_id: ids[problem], courseId: ids[course], psetId: ids[pset], skills: [ids[skill]], visible: true, peerReviewable: true, description: problem, problemText: 'question', mimeType: 'plain', pendingReviews: []});
    db.Answer.rows.push({_id: ids[answer], courseId: ids[course], psetId: ids[pset], problemId: ids[problem], studentId: ids.classmate, answer: 'protected answer', imageFilePath: `https://test-bucket.s3.us-east-1.amazonaws.com/studentImages/${answer}.png`, reviewers: [], pendingReviewers: [], numReviews: 0, review: 'official feedback', points: 99});
    db.Review.rows.push({_id: ids[review], courseId: ids[course], psetId: ids[pset], problemId: ids[problem], answerId: ids[answer], studentId: ids.classmate, reviewerId: ids.ta, skills: [], review: 'protected feedback', points: 99, upvoters: [], downvoters: []});
    db.RegradeRequest.rows.push({_id: ids[request], courseId: ids[course], psetId: ids[pset], problemId: ids[problem], answerId: ids[answer], studentId: ids.classmate, reviewId: ids[review]});
  }
  for (const [user, role] of [['ta', 'ta'], ['student', 'student'], ['classmate', 'student']]) db.CourseMember.rows.push({_id: id(200 + db.CourseMember.rows.length), courseId: ids.course, studentId: ids[user], role});
  db.Instructor.rows.push({_id: id(300), userId: ids.owner, status: 'active'});
  const modelSubstitutes = Object.fromEntries(Object.entries(db).flatMap(([name, model]) => [[`../models/${name}`, model], [`./models/${name}`, model], [`./models/${name}.js`, model]]));
  const material = load('routes/materialAccess.js', modelSubstitutes);
  const scope = load('routes/courseScope.js', {...modelSubstitutes, './materialAccess': material});
  const auth = load('routes/authFunctions.js', {...modelSubstitutes, './materialAccess': material, './courseScope': scope});
  const authRouter = express.Router();
  authRouter.use((req, res, next) => {
    req.user = db.User.rows.find(user => String(user._id) === req.headers['x-test-user']);
    req.isAuthenticated = () => !!req.user;
    res.locals.user = req.user || {}; res.locals.loggedIn = !!req.user;
    next();
  });
  const similarity = load('routes/similarity.js', {...modelSubstitutes, './authFunctions.js': auth});
  const uploads = [];
  class S3 {
    upload(params) {
      const task = new EventEmitter();
      task.send = cb => {
        const chunks = [];
        params.Body.on('data', chunk => chunks.push(chunk));
        params.Body.on('end', () => {uploads.push(params.Key); task.emit('httpUploadProgress', {total: Buffer.concat(chunks).length}); cb(null, {Location: `https://test-bucket.s3.us-east-1.amazonaws.com/${params.Key}`});});
      };
      return task;
    }
    deleteObject() {return {promise: async () => {}};}
  }
  const app = load('app.js', {
    ...modelSubstitutes,
    dotenv: {config() {}}, morgan: () => (req, res, next) => next(),
    mongoose: {Types, connect: () => Promise.resolve(), connection: new EventEmitter()},
    'aws-sdk': {config: {update() {}}, S3},
    'connect-mongo': () => session.MemoryStore,
    './routes/authRouter': authRouter, './routes/similarity': similarity,
    './routes/updatesARCHIVED.js': {}, './routes/authFunctions.js': auth,
    './routes/materialAccess': material, './routes/courseScope': scope,
    ...options.substitutes,
  }, {process: {env: {SESSION_SECRET: 'synthetic-test-secret', UPLOAD_TO: 'AWS', AWS_BUCKET_NAME: 'test-bucket', AWS_REGION: 'us-east-1', NODE_ENV: 'test'}},
    console: {log() {}, error() {}, dir() {}, warn() {}}});
  if (!options.realViews) app.response.render = function(view, locals) {this.json({view, ...this.locals, ...locals});};
  return {app, db, ids, writes, uploads, auth, scope};
}

async function serve(app, run) {
  const server = await new Promise(resolve => {const s = app.listen(0, '127.0.0.1', () => resolve(s));});
  const request = (url, {user, method = 'GET', body, headers = {}} = {}) => fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    method, redirect: 'manual', signal: AbortSignal.timeout(5000),
    headers: {...(user ? {'x-test-user': String(user)} : {}), ...headers}, body,
  });
  try {await run(request);} finally {await new Promise(resolve => server.close(resolve));}
}
module.exports = {fixture, serve};

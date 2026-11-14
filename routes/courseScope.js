const createError = require('http-errors');
const CourseMember = require('../models/CourseMember');
const CourseSkill = require('../models/CourseSkill');
const ProblemSet = require('../models/ProblemSet');
const Problem = require('../models/Problem');
const Answer = require('../models/Answer');
const Review = require('../models/Review');
const RegradeRequest = require('../models/RegradeRequest');
const Skill = require('../models/Skill');
const User = require('../models/User');
const {validId, sameId} = require('./materialAccess');

// Course permission and object scope are independent requirements. This loader
// checks all URL objects and their parent links before any route handler runs.
// sourceProblemId/otherCourseId are deliberately handled by materialAccess.
function scopeForCourse(courseId) {
  const scope = {courseId};
  async function scoped(Model, value, extra = {}) {
    if (!validId(String(value)) || typeof value === 'object' && !value?._bsontype) throw createError(404);
    const row = await Model.findOne({_id: value, courseId, ...extra});
    if (!row) throw createError(404);
    return row;
  }
  async function pset(value) {
    const row = await scoped(ProblemSet, value);
    if (scope.pset && !sameId(scope.pset, row)) throw createError(404);
    scope.pset = row;
    return row;
  }
  async function problem(value) {
    const row = await scoped(Problem, value);
    if (scope.problem && !sameId(scope.problem, row)) throw createError(404);
    await pset(row.psetId);
    scope.problem = row;
    return row;
  }
  async function answer(value) {
    const row = await scoped(Answer, value);
    if (scope.answer && !sameId(scope.answer, row)) throw createError(404);
    const parent = await problem(row.problemId);
    if (!sameId(row.psetId, parent.psetId)) throw createError(404);
    scope.answer = row;
    return row;
  }
  async function review(value) {
    const row = await scoped(Review, value);
    const parent = await answer(row.answerId);
    for (const key of ['psetId', 'problemId', 'studentId']) {
      if (!sameId(row[key], parent[key])) throw createError(404);
    }
    scope.review = row;
    return row;
  }
  async function regrade(value) {
    const row = await scoped(RegradeRequest, value);
    const parent = await review(row.reviewId);
    for (const key of ['answerId', 'psetId', 'problemId', 'studentId']) {
      if (!sameId(row[key], parent[key])) throw createError(404);
    }
    scope.regradeRequest = row;
    return row;
  }
  async function skill(value, owned = false) {
    if (!validId(String(value)) || typeof value === 'object' && !value?._bsontype) throw createError(404);
    const row = await Skill.findOne({_id: value});
    if (!row || (!sameId(row.courseId, courseId) && (owned || !await CourseSkill.findOne({courseId, skillId: value})))) {
      throw createError(404);
    }
    return row;
  }
  async function student(value) {
    if (!validId(String(value)) || typeof value === 'object' && !value?._bsontype) throw createError(404);
    // Historical submissions remain accessible to course staff after a student
    // leaves the roster. An arbitrary global user ID is never sufficient.
    if (!await CourseMember.findOne({courseId, studentId: value}) &&
        !await Answer.findOne({courseId, studentId: value})) throw createError(404);
    if (scope.answer && !sameId(scope.answer.studentId, value)) throw createError(404);
    return value;
  }
  return Object.assign(scope, {psetById: pset, problemById: problem, answerById: answer,
    reviewById: review, regradeById: regrade, skillById: skill, studentById: student});
}

async function validateParams(req, res) {
  const scope = scopeForCourse(req.params.courseId);
  req.courseScope = scope;
  for (const key of ['psetId', 'examId']) if (req.params[key]) await scope.psetById(req.params[key]);
  if (req.params.probId) await scope.problemById(req.params.probId);
  if (req.params.answerId) await scope.answerById(req.params.answerId);
  if (req.params.reviewId) await scope.reviewById(req.params.reviewId);
  for (const key of ['requestId', 'regradeRequestId']) if (req.params[key]) await scope.regradeById(req.params[key]);
  if (req.params.skillId) await scope.skillById(req.params.skillId);
  if (req.params.studentId) await scope.studentById(req.params.studentId);
  if (req.query.theStudentId) {
    if (!res.locals.isStaff) throw createError(403);
    await scope.studentById(req.query.theStudentId);
  }
  if (req.query.studentEmail) {
    if (!res.locals.isStaff || typeof req.query.studentEmail !== 'string') throw createError(403);
    const user = await User.findOne({googleemail: req.query.studentEmail});
    if (!user) throw createError(404);
    await scope.studentById(user._id);
  }
  if (req.params.userId && !sameId(req.params.userId, req.user._id)) throw createError(403);
  if (req.query.makeupId) await scope.psetById(req.query.makeupId);
}

// Request-body IDs must also be checked after multipart fields have been parsed.
// Use a separate loader for each makeup/skill: these are references, not the
// primary pset/problem whose identity must match the rest of the URL chain.
async function validateBody(req) {
  const scope = scopeForCourse(req.params.courseId);
  const body = req.body || {};
  for (const key of ['psetId', 'makeupOf', 'makeupSet']) {
    if (body[key]) {
      const row = await scopeForCourse(req.params.courseId).psetById(body[key]);
      if (key === 'psetId' && req.courseScope.pset && !sameId(row, req.courseScope.pset)) throw createError(404);
    }
  }
  for (const key of ['skill', 'skills']) {
    if (body[key] !== undefined) {
      const values = Array.isArray(body[key]) ? body[key] : [body[key]];
      for (const value of values) await scope.skillById(value);
    }
  }
}

async function validateBodyScope(req, res, next) {
  try {await validateBody(req); next();} catch (err) {next(err);}
}

async function requireSkillOwner(req, res, next) {
  try {await req.courseScope.skillById(req.params.skillId, true); next();} catch (err) {next(err);}
}

module.exports = {scopeForCourse, validateParams, validateBody, validateBodyScope, requireSkillOwner};

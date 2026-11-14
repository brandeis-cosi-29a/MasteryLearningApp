const Course = require('../models/Course');
const Problem = require('../models/Problem');
const ProblemSet = require('../models/ProblemSet');
const createError = require('http-errors');
const {approvedOwnerIds} = require('./courseOwnerAccess');

const validId = value => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
const sameId = (a, b) => a != null && b != null && String(a._id || a) === String(b._id || b);
const MATERIAL_FIELDS = 'courseId psetId description problemText mimeType answerMimeType rubric skills points parentProblemId variant visible allowAnswers submitable answerable peerReviewable';

// Sharing authorizes teaching-material reads, never student-record access.
const materialCourseFilter = async userId => ({
  ownerId: {$in: await approvedOwnerIds()},
  $or: [{ownerId: userId}, {guestAccess: {$in: ['instructors', 'all']}}],
});

async function requireMaterialSource(req, res, next) {
  try {
    let sourceCourseId = req.params.otherCourseId;
    if (req.params.sourceProblemId) {
      if (!validId(req.params.sourceProblemId)) throw createError(404);
      req.sourceProblem = await Problem.findOne({_id: req.params.sourceProblemId}).select(MATERIAL_FIELDS);
      if (!req.sourceProblem) throw createError(404);
      sourceCourseId = String(req.sourceProblem.courseId);
    }
    if (!validId(sourceCourseId)) throw createError(404);
    const source = await Course.findOne({_id: sourceCourseId, ...await materialCourseFilter(req.user._id)});
    if (!source) throw createError(404);
    if (req.sourceProblem && !await ProblemSet.findOne({_id: req.sourceProblem.psetId, courseId: source._id})) {
      throw createError(404);
    }
    req.sourceCourse = source;
    next();
  } catch (err) {next(err);}
}

function copyProblemMaterial(source, {courseId, psetId, skillId}) {
  // Do not copy pendingReviews or any state referencing source students.
  return {
    courseId, psetId, skills: [skillId], parentProblemId: source._id,
    description: source.description, problemText: source.problemText,
    mimeType: source.mimeType, answerMimeType: source.answerMimeType,
    rubric: source.rubric, points: source.points, variant: source.variant,
    createdAt: new Date(), pendingReviews: [],
    visible: source.visible, allowAnswers: source.allowAnswers,
    submitable: source.submitable, answerable: source.answerable,
    peerReviewable: source.peerReviewable,
  };
}

module.exports = {validId, sameId, MATERIAL_FIELDS, materialCourseFilter, requireMaterialSource, copyProblemMaterial};

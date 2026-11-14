const createError = require('http-errors');
const Answer = require('../models/Answer');
const Review = require('../models/Review');
const {sameId} = require('./materialAccess');

function peerReviewOpen(req, res) {
  return res.locals.isEnrolled && res.locals.course.courseType === 'pra' &&
    req.courseScope.problem?.visible === true && req.courseScope.problem.peerReviewable === true;
}

async function hasOwnSubmission(req) {
  return !!await Answer.findOne({courseId: req.params.courseId,
    psetId: req.courseScope.problem.psetId, problemId: req.courseScope.problem._id,
    studentId: req.user._id});
}

async function canBrowseAnswers(req, res) {
  if (res.locals.isStaff) return true;
  if (!peerReviewOpen(req, res) || !await hasOwnSubmission(req)) return false;
  // Count completed reviews of distinct, actually assigned answers. Forged or
  // duplicate historical review documents do not satisfy the threshold.
  const assigned = await Answer.find({courseId: req.params.courseId,
    psetId: req.courseScope.problem.psetId, problemId: req.courseScope.problem._id,
    studentId: {$ne: req.user._id}, reviewers: req.user._id});
  const reviews = await Review.find({courseId: req.params.courseId,
    psetId: req.courseScope.problem.psetId, problemId: req.courseScope.problem._id,
    reviewerId: req.user._id, answerId: {$in: assigned.map(a => a._id)}});
  const completed = new Set(reviews.filter(review => assigned.some(answer =>
    sameId(answer._id, review.answerId) && sameId(answer.studentId, review.studentId)))
    .map(review => String(review.answerId)));
  return completed.size >= 2;
}

async function canReadAnswer(req, res, answer) {
  if (res.locals.isStaff || sameId(answer.studentId, req.user._id)) return true;
  if (!peerReviewOpen(req, res) || !await hasOwnSubmission(req)) return false;
  return [...(answer.pendingReviewers || []), ...(answer.reviewers || [])]
    .some(reviewer => sameId(reviewer, req.user._id));
}

async function requireAnswerRead(req, res, next) {
  try {
    if (!await canReadAnswer(req, res, req.courseScope.answer)) throw createError(403);
    next();
  } catch (err) {next(err);}
}

async function requireReviewWrite(req, res, next) {
  try {
    if (res.locals.isStaff) return next();
    const answer = req.courseScope.answer;
    if (!peerReviewOpen(req, res) || sameId(answer.studentId, req.user._id) ||
        !await hasOwnSubmission(req) ||
        !(answer.pendingReviewers || []).some(reviewer => sameId(reviewer, req.user._id))) throw createError(403);
    const previous = await Review.findOne({courseId: req.params.courseId,
      psetId: answer.psetId, problemId: answer.problemId, answerId: answer._id, reviewerId: req.user._id});
    if (previous) throw createError(403);
    next();
  } catch (err) {next(err);}
}

async function requirePeerAssignment(req, res, next) {
  try {
    if (res.locals.isStaff) return next();
    if (!peerReviewOpen(req, res) || !await hasOwnSubmission(req)) throw createError(403);
    next();
  } catch (err) {next(err);}
}

async function requireRegradeOwner(req, res, next) {
  try {
    if (!res.locals.isStaff && !sameId(req.courseScope.review.studentId, req.user._id)) throw createError(403);
    next();
  } catch (err) {next(err);}
}

async function requireReviewRead(req, res, next) {
  try {
    const review = req.courseScope.review;
    if (!res.locals.isStaff && !sameId(review.studentId, req.user._id) &&
        !sameId(review.reviewerId, req.user._id)) throw createError(403);
    if (!await canReadAnswer(req, res, req.courseScope.answer)) throw createError(403);
    next();
  } catch (err) {next(err);}
}

// This projection is deliberately separate from a grade-bearing Answer object.
const answerContent = answer => ({_id: answer._id, courseId: answer.courseId,
  psetId: answer.psetId, problemId: answer.problemId,
  answer: answer.answer, imageFilePath: answer.imageFilePath});

module.exports = {peerReviewOpen, hasOwnSubmission, canBrowseAnswers, canReadAnswer,
  requireAnswerRead, requireReviewWrite, requirePeerAssignment, requireRegradeOwner,
  requireReviewRead, answerContent};

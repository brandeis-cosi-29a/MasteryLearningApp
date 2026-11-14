const Instructor = require('../models/Instructor');
const createError = require('http-errors');

// Semester-end policy: a membership is useful only within a course whose owner
// has active institutional approval. Read approval on each request so revocation
// also applies to already authenticated sessions. Administrators retain recovery.
async function requireApprovedCourseOwner(course, isAdmin) {
  if (isAdmin) return;
  if (course.accessDisabled === true) throw createError(403, 'Course access is disabled.');
  if (!course.ownerId || !await Instructor.findOne({userId: course.ownerId, status: 'active'})) {
    throw createError(403, 'This course requires instructor approval.');
  }
}

async function approvedOwnerIds() {
  const approvals = await Instructor.find({status: 'active'}).select('userId');
  return approvals.map(approval => approval.userId).filter(Boolean);
}

module.exports = {requireApprovedCourseOwner, approvedOwnerIds};

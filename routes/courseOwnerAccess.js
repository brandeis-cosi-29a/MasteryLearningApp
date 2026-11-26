const Instructor = require('../models/Instructor');
const createError = require('http-errors');

function courseAccessReason(course, ownerApproved) {
  if (course.accessDisabled === true) return 'Course access is disabled.';
  if (!ownerApproved) return 'This course requires instructor approval.';
  return null;
}

// Semester-end policy: a membership is useful only within a course whose owner
// has active institutional approval. Read approval on each request so revocation
// also applies to already authenticated sessions. Administrators retain recovery.
async function requireApprovedCourseOwner(course, isAdmin) {
  if (isAdmin) return;
  const ownerApproved = course.accessDisabled !== true && course.ownerId &&
    await Instructor.findOne({userId: course.ownerId, status: 'active'});
  const reason = courseAccessReason(course, ownerApproved);
  if (reason) throw createError(403, reason);
}

async function approvedOwnerIds(ownerIds) {
  const approvals = await Instructor.find({status: 'active',
    ...(ownerIds ? {userId: {$in: ownerIds}} : {}),
  }).select('userId');
  return approvals.map(approval => approval.userId).filter(Boolean);
}

// Limit the home-page lookup to owners of the user's listed courses. These
// annotations explain availability; course requests still check current state.
async function courseAccessReasons(courses) {
  const ownerIds = [...new Set(courses.map(course => course.ownerId).filter(Boolean).map(String))];
  const approved = new Set((await approvedOwnerIds(ownerIds)).map(String));
  return Object.fromEntries(courses.map(course => [String(course._id),
    courseAccessReason(course, approved.has(String(course.ownerId))),
  ]));
}

module.exports = {requireApprovedCourseOwner, approvedOwnerIds, courseAccessReasons};

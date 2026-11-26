/*
  Authentication Middleware 
  There are five levels of authentication 
  1. not logged in
  2. user: logged in
  3. student: logged in and enrolled in a course
  4. ta: logged in and TA for a course
  5. owner: logged in and owner of a course
We set the authorization checking so that 
the user must be logged in to access any of route except "/login"
*/

const Course = require("../models/Course");
const CourseMember = require("../models/CourseMember");
const Instructor = require("../models/Instructor");
const createError = require('http-errors');
const {validId, sameId} = require('./materialAccess');
const {validateParams, validateBody} = require('./courseScope');
const {normalizeEmail} = require('../config/emailIdentity');
const adminEmail = normalizeEmail(process.env.ADMIN_EMAIL);
const isAdminEmail = email => !!adminEmail && normalizeEmail(email) === adminEmail;
const {requireApprovedCourseOwner} = require('./courseOwnerAccess');


// route middleware to make sure a user is logged in
const isLoggedIn = async (req, res, next) => {
    res.locals.loggedIn = false;
    if (req.isAuthenticated()) {
      res.locals.loggedIn = true;
      const instructor = await Instructor.findOne({userId: req.user._id, status: 'active'});
      res.locals.isInstructor = !!instructor;
      res.locals.isAdmin = isAdminEmail(req.user.googleemail);
      res.locals.admin_email = adminEmail;
      let courseTaMember 
        = await CourseMember.findOne({studentId: req.user._id, role: "ta"});
      res.locals.isTA = courseTaMember != null;
      return next();
    } else {
      res.redirect("/login");
    }
  }

  /* 
  this middleware can be applied to any route that has a courseId parameter.
  If the user is not logged in, it will redirect to the login page.
  Otherwise, it will set the following locals:
  courseInfo: the course object
  isEnrolled: true if the user is enrolled in the course
  isTA: true if the user is a TA for the course
  isOwner: true if the user is the owner of the course
  isAdmin: true if the user is the admin
  isStaff: true if the user is a TA or the owner of the course

  */
  


  const authorize = async (req, res, next) => {
    try {
      if (!req.isAuthenticated()) return res.redirect('/login');
      if (!validId(req.params.courseId)) throw createError(404);
      const course = await Course.findOne({_id: req.params.courseId});
      if (!course) throw createError(404);
      const isAdministrator = isAdminEmail(req.user.googleemail);
      const member = await CourseMember.findOne({studentId: req.user._id, courseId: course._id});
      const instructor = await Instructor.findOne({userId: req.user._id, status: 'active'});
      res.locals.courseInfo = res.locals.course = course;
      res.locals.isInstructor = !!instructor;
      res.locals.isAdmin = isAdministrator;
      res.locals.isTA = member?.role === 'ta';
      res.locals.isEnrolled = member?.role === 'student';
      // Preserve existing owner/admin and approved-instructor-as-TA permissions,
      // without creating memberships as a side effect of a read request.
      res.locals.isOwner = member?.role === 'owner' || res.locals.isAdmin ||
        sameId(course.ownerId, req.user._id) || (!!instructor && res.locals.isTA);
      res.locals.isStaff = res.locals.isTA || res.locals.isOwner;
      res.locals.hasCourseAccess = res.locals.isEnrolled || res.locals.isStaff;
      if (!res.locals.hasCourseAccess) throw createError(403);
      // Only existing course participants may learn its approval/lock state.
      await requireApprovedCourseOwner(course, isAdministrator);
      res.set('Cache-Control', 'private, no-store');
      await validateParams(req, res);
      await validateBody(req);
      next();
    } catch (e) {
      next(e);
    }
  }


  
  const hasCourseAccess = async (req, res, next) => {
    // students, TAs, and owners have access to the course
    try {
      if (res.locals.isEnrolled || res.locals.isTA || res.locals.isOwner) {
        next();
      } else {
        res.status(403).send("You do not have access to this course.");
      }
    } catch (e) {
      next(e);
    }
  }
  
  const hasStaffAccess = async (req, res, next) => {
    // Teaching Staff and Owners have access to the course route
    try {
      if (res.locals.isOwner || res.locals.isTA) {
        next();
      } else {
        res.status(403).send("Only TAs and the owner have access to this page.");
      }
    } catch (e) {
      next(e);
    }
  }

  const isInstructor = async (req, res, next) => {
    try {
      if (!req.user) {
        res.redirect("/login"); 
      } else {
        // only instructors have access to this route
        // if the user is not an instructor, they will be redirected to the home page
        // if they are an instructor, they will be able to access the route
        // and the next() function will be called
        const instructor 
          = await Instructor.findOne({userId: req.user._id, status: "active"});
        if (instructor) {
          next();
        } else {
          res.status(403).send("Only approved instructors have access to this page.");
        }
      }
    } catch (e) {
      next(e);
    }
  }

  const isOwner = async (req, res, next) => {
    try {
      if (res.locals.isOwner) {
        next();
      } else {
        res.status(403).send("Only the owner has access to this page.");
      }
    } catch (e) {
      next(e);
    }
  }
  
  
  const isAdmin = async (req, res, next) => {
    try {
      if (!req.user) return res.redirect("/login");
      if (isAdminEmail(req.user.googleemail)){
        res.locals.isAdmin = true;
        next()
      } else {
        res.status(403).send("Only the admin has access to this page.");
      }      
    } catch (e) {
      next(e);
    }
  }

    module.exports = {
        authorize,
        isLoggedIn,
        hasCourseAccess,
        hasStaffAccess,
        isOwner,
        isInstructor,
        isAdmin,
    };


'use strict';

const GoogleStrategy = require('passport-google-oauth').OAuth2Strategy;
const User = require('../models/User');
const CourseMember = require('../models/CourseMember');
const Instructor = require('../models/Instructor');
const {normalizeEmail, validEmail, findUserByEmail} = require('./emailIdentity');
require('dotenv').config();

module.exports = function (passport) {
  const adminEmail = normalizeEmail(process.env.ADMIN_EMAIL);
  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser((id, done) => {
    User.findById(id).then(user => done(null, user), done);
  });

  async function authenticateGoogle(profile) {
    // Passport fetches these claims server-to-server from Google's UserInfo
    // endpoint using the code's access token. Do not trust request parameters,
    // an email suffix, or an unverified decoded ID token for the domain gate.
    const claims = profile?._json;
    const email = normalizeEmail(claims?.email);
    if (profile?.provider !== 'google' || typeof profile.id !== 'string' || !profile.id || claims?.sub !== profile.id ||
        claims?.email_verified !== true || !validEmail(email)) return false;

    let user;
    try {
      user = await findUserByEmail(User, email, profile.id);
    } catch (error) {
      if (error.status === 409) return false;
      throw error;
    }
    let allowed = claims.hd === 'brandeis.edu' || (!!adminEmail && email === adminEmail);
    if (!allowed && user) {
      // This is a sign-in admission rule, not course authorization. Any existing
      // membership/instructor record qualifies; course roles/status still apply
      // in the route middleware, including dropped/inactive/denied records.
      allowed = !!(await CourseMember.findOne({studentId: user._id})) ||
        !!(await Instructor.findOne({userId: user._id}));
    }
    if (!allowed) return false; // No creation, linking, normalization, or token writes on denial.

    if (!user) {
      return new User({googleid: profile.id, googleemail: email, googlename: profile.displayName}).save();
    }
    if (!user.googleid) {
      user.googleid = profile.id;
      user.googlename = profile.displayName;
      await user.save();
    }
    // Google access/refresh tokens are not used by MLA and must not be stored.
    // Preserve the stored email: existing PostedGrades use it as an exact key.
    return user;
  }

  passport.use(new GoogleStrategy({
    clientID: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    callbackURL: process.env.CALLBACK_URL,
    state: true,
  }, function (accessToken, refreshToken, profile, done) {
    authenticateGoogle(profile).then(user => done(null, user), done);
  }));
};

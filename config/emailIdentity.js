'use strict';

const createError = require('http-errors');

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function validEmail(value) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function findUserByEmail(User, value, googleId) {
  const email = normalizeEmail(value);
  if (!validEmail(email)) throw createError(400, 'A valid email address is required.');
  // Preserve IDs and enrollments for legacy mixed-case/space-padded addresses.
  // Escape metacharacters: roster addresses are data, never regular expressions.
  const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const filter = {googleemail: new RegExp('^\\s*' + escaped + '\\s*$', 'i')};
  const users = await User.find(filter).limit(2);
  // Never pick an arbitrary account or merge course data when identities collide.
  if (users.length > 1) {
    // Only Google's authenticated subject can disambiguate existing links.
    // Roster edits have no Google subject, so must stop for manual cleanup.
    if (googleId) {
      const linked = await User.find({...filter, googleid: googleId}).limit(2);
      if (linked.length === 1) return linked[0];
    }
    throw createError(409, 'Duplicate email records require administrator assistance.');
  }
  return users[0] || null;
}

module.exports = {normalizeEmail, validEmail, findUserByEmail};

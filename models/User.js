"use strict";
const mongoose = require("mongoose");
const Schema = mongoose.Schema;

var userSchema = Schema({
  googleid: String,
  googletoken: String,
  googlename: String,
  // Keep the index for exact email lookups elsewhere in the app. Login uses
  // emailIdentity.findUserByEmail's anchored case-insensitive, space-tolerant
  // regex, which cannot use this index tightly.
  googleemail: {type: String, index: true},
  // Legacy local-login values remain stored but excluded from normal queries.
  // Google authentication does not use or rewrite them.
  hash: {type: String, select: false},
  salt: {type: String, select: false},
});

module.exports = mongoose.model("User", userSchema);



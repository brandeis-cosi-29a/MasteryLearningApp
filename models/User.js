"use strict";
const mongoose = require("mongoose");
const Schema = mongoose.Schema;
const passportLocalMongoose = require("passport-local-mongoose");

var userSchema = Schema({
  googleid: String,
  googletoken: String,
  googlename: String,
  // Keep the index for exact email lookups elsewhere in the app. Login uses
  // emailIdentity.findUserByEmail's anchored case-insensitive, space-tolerant
  // regex, which cannot use this index tightly. Declaring the field here also
  // keeps passport-local-mongoose from adding its own unique index on it --
  // the plugin only defines the username field when the schema lacks that path.
  googleemail: {type: String, index: true},
});

userSchema.plugin(passportLocalMongoose, {usernameField: "googleemail"});

module.exports = mongoose.model("User", userSchema);



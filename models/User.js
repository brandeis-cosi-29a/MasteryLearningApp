"use strict";
const mongoose = require("mongoose");
const Schema = mongoose.Schema;
const passportLocalMongoose = require("passport-local-mongoose");

var userSchema = Schema({
  googleid: String,
  googletoken: String,
  googlename: String,
  // indexed because config/passport.js looks a user up by googleemail on every
  // single login.  Declaring the field here also keeps passport-local-mongoose
  // from adding its own unique index on it -- the plugin only defines the
  // username field when the schema does not already have that path.
  googleemail: {type: String, index: true},
});

userSchema.plugin(passportLocalMongoose, {usernameField: "googleemail"});

module.exports = mongoose.model("User", userSchema);



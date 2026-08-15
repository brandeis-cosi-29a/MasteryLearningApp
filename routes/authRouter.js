/*
  auth.js handles all of the authentication routes
*/
const express = require("express");
const app = express.Router();

// Authentication
var GoogleStrategy = require("passport-google-oauth").OAuth2Strategy;
// here we set up authentication with passport
const passport = require("passport");
const configPassport = require("../config/passport");
configPassport(passport);

// here are the authentication routes
app.use(passport.initialize());
app.use(passport.session());

// here is where we check on their logged in status
app.use(async (req, res, next) => {
    res.locals.loggedIn = false;
    if (req.isAuthenticated()) {
      res.locals.user = req.user;
      res.locals.loggedIn = true;


    } else {
      res.locals.user={};
      res.locals.loggedIn = false;
    }
    next();
  });

app.get("/loginerror", function (req, res) {
    res.render("loginerror", {}); 
  });
  
  app.get("/login", function (req, res) {
    res.render("login", {});
  });
  


  app.get("/logout", function(req, res, next) {
    req.logout(function(err) {
      if (err) {
        return next(err);
      }
      res.redirect("/");
    });
  });
  
  // =====================================
  // GOOGLE ROUTES =======================
  // =====================================
  // send to google to do the authentication
  // profile gets us their basic information including their name
  // email gets their emails
  app.get("/auth/google", passport.authenticate("google", {scope: ["profile", "email"]}));
  
  app.get(
    "/login/authorized",
    passport.authenticate("google", {
      successRedirect: "/",
      failureRedirect: "/loginerror",
    })
  );
  
module.exports = app;

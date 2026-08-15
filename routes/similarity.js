var express = require("express");
var app = express.Router();
const fs = require('fs');
const Answer = require("../models/Answer");

const {authorize, hasStaffAccess} = require('./authFunctions.js');

/*
Downloading every answer to a problem is a teaching-staff action, so it is
gated with hasStaffAccess rather than the student-level hasCourseAccess it
used to carry.  The authorize middleware has to come first: it is what sets
the res.locals the gate reads, and it is applied per route in app.js rather
than globally.  Without it the gate saw undefined locals and refused everyone,
so this handler was unreachable.

It still only writes files into private/ and answers ["testing"], which was
useful on the VM this was written for, where you could ssh in and run
private/dolos.sh over them.  It does nothing useful on a host with an
ephemeral disk and no shell, so the link to it has been taken out of
views/showProblemToStaff_MLA.ejs until it hands the bundle back to the
browser.
*/
app.get("/downloadAnswers/:courseId/:probId", authorize, hasStaffAccess,
  async (req, res, next) => {
    try {
      const probId = req.params.probId;
      res.locals.probId = probId;
      const answers = await Answer.find({problemId: probId}).populate('studentId');
      const csvStream = fs.createWriteStream("private/"+probId+".csv")
      csvStream.write("filename,created_at,full_name\n")
        for(let x of answers) {
            const writeStream = fs.createWriteStream("private/"+probId+"-"+x.studentId.googleemail);
            writeStream.write(x.answer)
            csvStream.write(""+probId+"-"+x.studentId.googleemail+","+x.createdAt+","+x.studentId.googleemail+"\n")
            writeStream.end()
        }
        csvStream.end()

      res.json(['testing']);
    
    } catch (e) {
      console.error("Error in showProblem: " + e);
      next(e);
    }
  });
  

module.exports = app;

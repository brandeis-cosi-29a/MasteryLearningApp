# Course authorization and private answer images

This change preserves separate problem-bank courses and legitimate Google
accounts outside the university domain. Authentication alone grants no course
creation or student-record permissions.

## Review sequence

1. **Course creation:** both the form and the POST action require an active
   `Instructor` approval. Direct requests by ordinary, pending, denied, or inactive
   accounts return 403 before any course or membership is written. Run `npm test`
   with Node 24; tests use synthetic identities and simulated persistence.

Production deployment and storage configuration are separate from opening this
PR. No production student records are used by the regression suite.

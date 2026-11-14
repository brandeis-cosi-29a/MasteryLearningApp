# Course authorization and private answer images

This change preserves separate problem-bank courses and legitimate Google
accounts outside the university domain. Authentication alone grants no course
creation or student-record permissions.

## Review sequence

1. **Course creation:** both the form and the POST action require an active
   `Instructor` approval. Direct requests by ordinary, pending, denied, or inactive
   accounts return 403 before any course or membership is written. Run `npm test`
   with Node 24; tests use synthetic identities and simulated persistence.

2. **Problem-bank material:** browsing, previewing, and importing require active
   instructor approval and destination management permission. The source must be
   owned by the requester or shared with instructors (`instructors` or `all`).
   Source sharing grants no answer, grade, roster, or review access. Previews use
   a separate material-only route; imported problems get destination IDs and
   fresh review state, and start hidden until released. Skill lineage and problem
   parent references remain available for the existing library matching.

Production deployment and storage configuration are separate from opening this
PR. No production student records are used by the regression suite.

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

3. **Course object scope:** the shared course middleware validates URL objects
   and their complete parent chain (course, problem set, problem, answer, review,
   regrade request). Students targeted by staff must have course membership or a
   historical course submission. Skill reads/assignments accept explicit
   `CourseSkill` links for legacy sharing, while editing requires owning the
   skill's actual course. Body/query references and multipart fields are checked
   before handlers write; photo targets are checked before the storage middleware.
   Malformed or mismatched objects return 404, and missing permission returns 403.
   Authorization no longer creates owner memberships during read requests.
   The HTTP regression suite exercises every mounted route carrying object IDs,
   foreign parents, same-course parent mismatches, and multipart/body/query IDs.

4. **Record actions and peer review:** students can read their own records, or
   answer content and their own reviews for a server-issued peer assignment in a
   visible, peer-reviewable PRA problem after submitting their own answer. Staff
   retain grading and image-replacement privileges in their actual course. Peer
   reviews cannot become official grades. Class-wide PRA browsing additionally
   requires completed assigned reviews of two distinct answers; its separate view
   returns answer content only, with no app-supplied identities, timestamps,
   grades, or other reviewers' feedback. Text/images may themselves identify their
   author. These agreed eligibility rules live in `routes/recordAccess.js` so
   future workflow changes can adjust them in one place.
   Review deletion remains available to staff; all bulk targets are checked
   before writes, each affected answer is updated, and deleting its official
   review clears the copied official grade rather than leaving a dangling grade.

Production deployment and storage configuration are separate from opening this
PR. No production student records are used by the regression suite.

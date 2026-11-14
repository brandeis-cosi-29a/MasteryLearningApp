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
   fresh review state, and retain the source material's availability flags. Skill
   lineage and problem parent references remain available for the existing library matching.

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

5. **Private answer images:** all image links use `/answerImage/:courseId/:answerId`.
   The route validates the answer's full course/problem-set/problem relationship
   and permits its student, actual course staff, an assigned peer, or an eligible
   class-content browser. S3 keys are resolved only within the configured bucket
   and student-image prefix, never by fetching a caller-supplied URL. Responses
   are private/no-store. The server does not listen until all four bucket-level
   S3 public-access blocks are verified; denied/missing checks fail startup.
   Existing stored URLs remain usable as storage references and need no bulk
   database rewrite. They are no longer emitted as image links.

## Deployment: required storage cutover

Opening this PR changes no production infrastructure or student records. Do not
merge into an auto-deploying production branch until the following cutover is
prepared. Making the bucket private changes how the old application displays
images, so coordinate the bucket change and application deployment; allow a short
image-availability interruption unless using a separate staging deployment.

1. Test the branch against a separate database and bucket containing synthetic
   records. Confirm instructor approval and the source bank's sharing settings
   permit the intended destination courses. Review existing ownership/TA grants
   separately; `active: false` archives a course and does **not** revoke its roles.
   The patch deliberately does not delete existing memberships or course data.
2. The application IAM principal needs `s3:GetObject`, `s3:PutObject` and its
   existing upload/delete permissions on the answer-image prefix, plus
   `s3:GetBucketPublicAccessBlock` on the configured bucket. Production still uses
   `UPLOAD_TO=AWS`, `AWS_BUCKET_NAME`, and `AWS_REGION`. No extra secret is needed.
3. Using an administrative AWS identity, enable **all four** Block Public Access
   settings on the existing answer-image bucket. This includes the settings that
   override existing public ACLs/policies, not only those that prevent new ones:

   ```sh
   aws s3api put-public-access-block \
     --bucket "$AWS_BUCKET_NAME" \
     --public-access-block-configuration \
     'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true'
   aws s3api get-public-access-block --bucket "$AWS_BUCKET_NAME"
   ```

   The startup check is read-only; the application does not receive permission
   to change bucket privacy. Account-level blocks are also useful, but the check
   deliberately requires these bucket-level settings for this deployment.
4. Deploy this branch's application. Confirm the storage check succeeds before
   the server accepts requests. With a synthetic answer, verify the student and
   course staff see its image, an unrelated account cannot, and its old unsigned
   S3 URL returns no image when fetched anonymously. Repeat for representative
   existing image URLs under an authorized institutional validation process.
   Test assigned-peer and eligible class-content browsing if PRA is in use.
5. Retest the cross-course substitutions for reads, grading, uploads, regrades,
   and bulk actions. Test the actual problem-bank preview/import workflow and
   ordinary staff/student pages before treating the issue as technically closed.

AWS explains how Block Public Access overrides public policies/permissions in
[its S3 documentation](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html).
No cloud changes, production student-record reads, merges, or deployments are
performed by the regression suite or by preparing this PR.

## Local testbed

Local image storage requires all of `UPLOAD_TO=LOCAL`,
`ALLOW_LOCAL_ANSWER_STORAGE=true`, and `NODE_ENV=development` or `test`.
`bin/www` binds a local-storage testbed to `127.0.0.1` only. Production rejects
local, missing, and unrecognized storage modes. Files live in ignored
`private/answerImages`, outside the static tree; old `/answerImages/...` routes
are blocked, including encoded paths. For a pre-existing local testbed, move its
legacy answer files from `public/answerImages` to `private/answerImages` before
using the protected image route. Legacy local filenames remain supported.

Run `npm test` on Node 24. Tests use real Express/Multer/EJS and the production
routes with synthetic identities, simulated MongoDB/S3, and localhost servers.
The suite does not substitute permissive versions of the authorization helpers.

## Compatibility validation

The regression suite covers a separate shared bank through skill import, library
search, preview, and problem copying, including source sharing revocation. It
also exercises own feedback/regrades, staff grading/rosters/grade exports, peer
assignment/history/class browsing, first photo uploads, staff replacements,
fileless submissions, oversized photos, and authorization before any storage
write. Import availability flags retain their previous behavior; no schema or
bulk URL migration is required.

Permission helpers are kept separate from views and storage so later instructor
policy decisions can change eligibility without rewriting these workflows.

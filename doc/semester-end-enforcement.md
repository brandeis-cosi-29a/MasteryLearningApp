# Semester-end course enforcement

This separate change extends the course/record authorization work in PR #10
and is stacked on PR #18 (`chore/unused-dependencies`). It must land after the
dependency stack in PRs #14–#18 and must not be enabled for running courses
before the agreed semester-end review. Preparing these commits does not inspect
or modify production records, approvals, credentials, or hosting settings.

## Code behavior

Every non-administrator course request requires an `Instructor` record for the
actual `Course.ownerId` with `status: active`. Existing owner, TA, and student
memberships do not bypass this check. Missing, requested, inactive, or denied
approval blocks all of those roles. Administrators retain access to investigate
and restore legitimate courses; object-relationship checks still apply to them.

The same approval requirement applies to source courses for shared-material
listing, preview, and import. A shared bank must have an approved owner as well
as an appropriate sharing setting. Approval/revocation is read on each request,
including requests from existing sessions. The check writes no memberships or
student records.

Approving an owner permits existing course grants to be used again; it does not
establish that those grants were legitimate. Course and membership review are
therefore necessary alongside the code change.

## Reversible course lock

`Course.accessDisabled: true` blocks non-administrator course access and removes
the course from shared-material listings, previews, and imports, even if its
owner remains approved. This allows one course to be quarantined without
affecting other courses owned by the same instructor. Administrators retain
record access for recovery. No public course-edit route can change this field;
it is set only through the institution's administrative database process.

The field defaults to false; existing records without it remain unlocked. No
bulk migration is needed. `active: false` still means archived, and does not
revoke access. Locking does not delete courses, memberships, answers, grades, or
images. Unlocking restores whatever existing grants allow, so review those
grants before restoring a quarantined course.

## Choose the action

| Intended outcome | Action | Effect |
| --- | --- | --- |
| Keep a legitimate course usable | Verify its actual owner and approve that instructor; review memberships | Existing legitimate workflows remain available once the course is unlocked |
| Suspend one course | Set that course's `accessDisabled` to true | Blocks non-administrators and new sharing/imports for that course only |
| Remove an unauthorized participant or staff grant | Remove the exact reviewed membership row(s) | Other grants and actual course ownership must also be checked |
| Move a course or bank to a current custodian | Lock it, change its actual owner to a verified approved account, review/remove old grants, then unlock | Keeps course IDs and teaching material in place |
| Remove one instructor's global approval | Make all active approval rows for that exact account inactive | Blocks their unlocked courses for non-administrators; does not remove their TA/student memberships elsewhere |
| Hide an old course from current listings | Set `active` to false | Archives the course; does not revoke access |

Deleting courses, users, submissions, grades, or images is not necessary to
enforce access. Do not use the application's bulk student-data deletion action
for this process. Lock first if a course's legitimacy is unsettled, preserve its
records, and let the authorized institutional team decide any eventual cleanup.

## Before changing production

1. Wait until grades have been submitted for every course that the proposed
   change could affect. Confirm timing with its responsible instructor; there is
   no automatic date or scheduled switch in this branch.
2. PR #10's object-authorization and private-image changes must already be
   deployed and validated. Keep its S3 protections in place throughout this work.
3. Have an authorized administrator prepare a private inventory of course IDs,
   actual owner user IDs, approval statuses, staff/student memberships, sharing
   settings, and the intended disposition. Verify against institutional course
   and staff assignments and approved rosters, not merely the app's old grants.
   Include archived courses and source problem banks. Inspect all membership
   rows for each course/user pair; duplicate rows can retain another grant.
4. Review the impact of each instructor approval across **all** courses owned by
   that account. Approval is global and also changes management privileges where
   the account is already a TA under the existing policy. Do not approve every
   old owner simply to avoid disruption. Do not approve a departed or unknown
   account just to keep a bank available; transfer it to a verified custodian.
5. Classify each course as keep, transfer, or quarantine. Confirm a working
   administrator account before the cutover. Store exact before/after values and
   backups of affected rows in the institution's approved private system.

The assistant has not run the administrative queries or updates below. They are
templates for the authorized operator. Connect using the institution's approved
database environment and credentials, outside chat. Replace the placeholders
privately; do not paste real records, credentials, or query output into Git,
issues, PRs, or this document. No student answer text, grades, feedback, image
contents, OAuth tokens, or account credentials are needed for these examples.

## Administrative steps and exact-target templates

Use a maintenance window for the cutover. Application versions without this
follow-up **ignore** `accessDisabled`: setting the field in advance
does not itself protect a course. If records need to be isolated during the
preparation window, use the institution's existing maintenance/access controls
until this code is serving. No such controls are changed by preparing this work.

The examples below run in an already authorized MongoDB shell. Each write is
limited to a selected course or a reviewed membership. Do not replace a narrow
filter with a broader one when it matches nothing; stop and inspect the current
state. Record the original value before each change.

### 1. Inspect one selected course and its approval

```javascript
const semesterCourseId = ObjectId("REPLACE_WITH_COURSE_ID");
const semesterOwnerId = ObjectId("REPLACE_WITH_RECORDED_OWNER_USER_ID");

db.courses.find(
  {_id: semesterCourseId},
  {_id: 1, ownerId: 1, active: 1, accessDisabled: 1, guestAccess: 1}
);
db.instructors.find(
  {userId: semesterOwnerId},
  {_id: 1, userId: 1, status: 1}
);
db.coursemembers.find(
  {courseId: semesterCourseId},
  {_id: 1, studentId: 1, role: 1}
);
db.courses.find(
  {ownerId: semesterOwnerId},
  {_id: 1, ownerId: 1, active: 1, accessDisabled: 1}
);
```

Internal user IDs and role lists still belong in the operator's private review.
Use authorized institutional sources to determine who should hold each grant.
An active approval passes the gate even if duplicate inactive approval rows also
exist. A missing owner requires a verified ownership correction; do not create
or approve an account merely because a stale ID appears in the course record.

### 2. Lock a course selected for quarantine or ownership correction

If it is already locked, skip this write and verify the existing lock.

```javascript
const semesterLock = db.courses.updateOne(
  {_id: semesterCourseId, ownerId: semesterOwnerId, accessDisabled: {$ne: true}},
  {$set: {accessDisabled: true}}
);
if (semesterLock.matchedCount !== 1) throw Error("Stop: selected course state changed.");
```

This preserves the owner, memberships, submissions, grades, and images. Once the
follow-up code is serving, administrator access remains available while owner,
TA, and student requests are denied. Other courses of the same owner continue
to follow their own approval and lock state.

### 3. Approve legitimate owners or transfer ownership

Use the application's administrator-only instructor screen (`/instructors`) to
approve a verified account. Verify the resulting approval records for that exact
user, including duplicates. Review all courses and staff roles affected by the
global approval before enabling it; keep suspect courses locked.

If ownership must change, keep the course locked. Confirm the new owner against
institutional records and active instructor approvals, then update only the
selected course:

```javascript
const semesterApprovedOwnerId = ObjectId("REPLACE_WITH_VERIFIED_NEW_OWNER_USER_ID");
if (!db.instructors.findOne({userId: semesterApprovedOwnerId, status: "active"})) {
  throw Error("Stop: verified replacement owner needs active instructor approval.");
}
const semesterTransfer = db.courses.updateOne(
  {_id: semesterCourseId, ownerId: semesterOwnerId, accessDisabled: true},
  {$set: {ownerId: semesterApprovedOwnerId}}
);
if (semesterTransfer.matchedCount !== 1) throw Error("Stop: selected course state changed.");
```

Changing `ownerId` does **not** revoke the former owner's independent `owner` or
TA memberships. Review and remove unwanted grants in the next step. The new
actual owner does not need an additional owner-membership row for this code's
owner check. Keep the course ID and problem-bank content unchanged; there is no
need to recreate the bank or rewrite imported copies.

### 4. Revoke only reviewed unauthorized memberships

For each row confirmed to be unauthorized, record its exact original values
privately, then remove that row with its expected course, user, and role:

```javascript
const semesterMembershipId = ObjectId("REPLACE_WITH_REVIEWED_MEMBERSHIP_ROW_ID");
const semesterMemberId = ObjectId("REPLACE_WITH_REVIEWED_MEMBER_USER_ID");
const semesterRecordedRole = "REPLACE_WITH_RECORDED_ROLE";

const semesterRemoval = db.coursemembers.deleteOne({
  _id: semesterMembershipId,
  courseId: semesterCourseId,
  studentId: semesterMemberId,
  role: semesterRecordedRole
});
if (semesterRemoval.deletedCount !== 1) throw Error("Stop: selected membership state changed.");
```

Check for other rows for that same course/user. Removing an owner-membership row
does not revoke access granted by `Course.ownerId`; transfer or lock the course
as appropriate. Removing instructor approval alone does not revoke a TA role in
a course owned by someone else. Do not delete the global User record to revoke
one course grant. Staff can still access a former student's historical course
submissions under the existing scoped-record rules.

If an account's global instructor approval itself must be revoked, review all
affected courses and use the administrator workflow. Verify that **no active
approval row remains** for that exact user. If duplicate rows require a database
correction, an authorized operator can use this exact-account update after
recording the matched rows and confirming its scope:

```javascript
db.instructors.updateMany(
  {userId: semesterOwnerId, status: "active"},
  {$set: {status: "inactive"}}
);
```

This is intentionally broader than a single-course lock: it blocks that user's
owned courses for all non-administrators. Use the lock for a single course when
other courses of the same owner should remain available.

### 5. Unlock only reviewed courses that should remain available

For an unchanged owner, set `semesterApprovedOwnerId` to its verified user ID.
For a transferred course, keep the new verified owner ID from step 3. Confirm
active approval, review memberships and any questionable stored relationships,
and record the disposition before running:

```javascript
if (!db.instructors.findOne({userId: semesterApprovedOwnerId, status: "active"})) {
  throw Error("Stop: course owner is not approved.");
}
const semesterUnlock = db.courses.updateOne(
  {_id: semesterCourseId, ownerId: semesterApprovedOwnerId, accessDisabled: true},
  {$set: {accessDisabled: false}}
);
if (semesterUnlock.matchedCount !== 1) throw Error("Stop: selected course state changed.");
```

Unlocking or reapproving an owner restores whatever other grants still allow;
neither operation validates old memberships or repairs altered records. Keep a
course locked if that review is incomplete. Do not automatically delete or
rewrite answers, reviews, grades, or images to resolve uncertain provenance.
Have the authorized institutional team assess those records privately.

## Prepare the future release and verify the cutover

The branch is `fix/semester-end-course-enforcement`, based on PR #18's head
`2006e0b7f00b282d154a9efa2313d4f6865e9991`. Review it separately and land it
only after PRs #14–#18, including their required code, browser, and login checks.
Merge and deploy only with the instructor's explicit go-ahead at the agreed
semester-end cutover, after grades have been submitted for every affected
course and the administrative review above is complete. Deploying this code
enables the policy immediately; there is no automatic date or scheduled switch.

After the dependency stack is squash-merged, verify that `origin/main` contains
all of its changes, then rebase **only this follow-up** onto the actual release
base. The command below uses the current PR #18 head as the old base; recheck
that boundary if a parent branch has changed or this branch has been rebased:

```sh
git fetch origin
git switch fix/semester-end-course-enforcement
git rebase --onto origin/main 2006e0b7f00b282d154a9efa2313d4f6865e9991
fnm exec --using 24.19.0 npm test
```

Resolve any later changes to the authorization helpers during review and rerun
the tests. Use a synthetic staging database and private test bucket to confirm:

- Missing, requested, inactive, and denied owners block existing owner/TA/student
  requests, images, grading, and uploads; there are no writes on rejection.
- Approved owners and reviewed memberships retain their ordinary workflows.
- A single-course lock leaves the same instructor's other courses available.
- Administrators retain recovery, and foreign-object mismatches remain denied.
- The Discrete Math Problem Bank has an approved custodian, is unlocked, and has
  the intended sharing setting. Its search/preview/import workflow still works.
- Locking a source bank prevents new source access/imports; it does not delete
  previously imported teaching-material copies in other approved courses.
- Revocation affects the next request from an existing session; an open tab or
  prior login does not bypass the new checks.

After the authorized production cutover, have the institution's designated
operators verify the selected courses and record the result in its private
change record. This preparation does not inspect production data or certify
that old grants or stored relationships have been reviewed.

## Recovery

Prefer correcting a verified owner's approval or ownership while its course is
locked. Restore only reviewed legitimate memberships from the private change
record. Keep uncertain courses locked rather than approving unknown accounts.

Reverting this follow-up also removes enforcement of `accessDisabled`
and the approved-owner rule; old locks would no longer protect those courses.
If a code rollback is necessary, arrange separate containment first. Retain
PR #10's object-level authorization and S3 privacy protections; do not roll back
those earlier fixes as a way to resolve an owner-approval problem.

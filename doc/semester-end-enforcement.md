# Semester-end course enforcement

This is a separate, future change based on the course/record authorization work
in PR #10. It is not part of that PR and must not be enabled for running courses
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

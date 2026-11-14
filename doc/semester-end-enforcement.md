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

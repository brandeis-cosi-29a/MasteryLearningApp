# Google sign-in admission

MLA admits a Google identity only when Google supplies a verified email address and at least
one of these conditions holds:

- Google's UserInfo `hd` claim equals `brandeis.edu`.
- The matching existing User has a CourseMember or Instructor record.
- The normalized email matches the configured `ADMIN_EMAIL` (including initial admin setup).

The claims come from the Google strategy's server-side UserInfo request after the authorization
code exchange. An email ending in `@brandeis.edu` is insufficient without Google's hosted-domain
claim. See [Google's claim reference](https://developers.google.com/identity/openid-connect/reference).
Every admission path requires `email_verified` to be the boolean `true`.

An outside account with only a self-provisioned User row is denied. Denial does not create a user,
attach a Google ID, normalize a stored email, save a token, or change memberships. The normal
failure redirect explains how to request roster access without identifying which check failed.

Membership and instructor *presence* admit sign-in, including dropped memberships and inactive,
requested, or denied instructor records. This does not grant course access or instructor approval;
existing route authorization continues to enforce those separately. Course-owner status alone is
not a separate sign-in exception.

## Identity handling

Email comparison ignores case and surrounding whitespace for sign-in, admin checks, manual
student/TA/instructor additions, and CSV roster loading. New users and grade-CSV imports store
normalized emails. Legacy case or surrounding spaces do not cause a new account: existing
users retain both their User ID and their stored email byte-for-byte, including when first linked
to Google. This preserves exact matches to previously saved PostedGrades. No bulk database
migration, saved-grade rewrite, or account merge is performed.

If multiple Users share a normalized email, sign-in selects a record only when exactly one has
the same Google subject ID as the authenticated identity. Otherwise sign-in fails. Roster edits
have no authenticated Google subject and return 409 for an ambiguous email. An administrator
must resolve ambiguous records after reviewing their memberships and data; the application must
not silently combine them or choose the first result.

New accounts and newly linked roster accounts no longer store Google access or refresh tokens.
Previously stored tokens are left untouched; this change does not bulk-remove historical tokens.

## OAuth sessions

The Google strategy enables Passport's session-backed OAuth `state` validation. Sign-in starts
in the same browser session that completes the callback. Missing, incorrect, cross-session, and
consumed state values fail before the token exchange. No `hd` hint restricts the Google account
picker, so rostered personal Google accounts remain usable.

Existing application sessions are not invalidated by this change. Admission is checked on the
next Google sign-in; existing course authorization remains in force in the meantime.

## Upgrade and verification

Before deployment, perform a read-only census of user emails, normalized-email collisions,
membership/instructor references, and course owners. Review accounts that lose admission and
resolve any collisions affecting needed access. Keep credentials and census evidence private;
neither belongs in the repository or PR. No schema/index migration or new environment variable
is required. Keep the Google consent audience External so rostered personal accounts can sign in.

Run `npm test` on Node 24. The OAuth tests use the installed Google profile parser, real Passport
and HTTP sessions, synthetic provider responses, and in-memory models. They cover admission,
denial without writes, duplicates, roster/CSV identity reuse, database errors, session serialization,
and OAuth state. They do not contact Google, Atlas, or S3.

After reviewed deployment, check a Brandeis Google login, a rostered personal Google login,
an unrostered outside-account denial, and the admin pages. Start a fresh sign-in flow after an
upgrade; an in-flight callback from a version without state validation will fail and must be retried.

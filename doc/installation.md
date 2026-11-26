# Installing and Deploying MLA
The Mastery Learning App is open source and you can deploy it yourself if you want.
You run a local version or a cloud-based version (but that requires more setup).

## Deploying MLA locally
This is pretty easy.
1. clone the MLA site
2. startup mongodb
3. get google credentials for authentication — see [Setting up Google OAuth credentials](#setting-up-google-oauth-credentials) below
4. create a .env file as described below
5. run nodemon

Sample .env file
``` bash
ADMIN_EMAIL=GMAIL OF THE ADMINISTRATOR
SESSION_SECRET=GENERATE ONE WITH: openssl rand -base64 32
CLIENT_ID=GOOGLE_CLIENT_ID_GOES_HERE
CLIENT_SECRET=GOOGLE_SECRET_GOES_HERE
CALLBACK_URL=http://127.0.0.1:5500/login/authorized
MONGODB_URL=mongodb://localhost:27017/PICK_A_DATABASE_NAME
UPLOAD_TO=LOCAL
NODE_ENV=development
ALLOW_LOCAL_ANSWER_STORAGE=true
```
the administrator has special privileges, including being able to add or remove instructors and to see all courses on the app.

### Optional: upload size limits

Uploads are capped per file. Both caps have defaults, so you only need these variables if you
want to change them, and either can be set on a deployed instance without a code change.

| variable | default | applies to |
|---|---|---|
| `MAX_UPLOAD_MB` | 25 | student answer photos |
| `MAX_STAFF_UPLOAD_MB` | 1 | roster and grade csv files, uploaded problem files |

A value that is not a positive number is ignored — the app logs a warning and uses the default,
rather than letting a typo become the limit. A file over the cap is rejected with an HTTP 413 and
an error page naming the limit; nothing is written to the database or to S3, so a rejected
re-upload leaves a student's existing answer image untouched.

### Optional: peer-review time limit

| variable | default | applies to |
|---|---|---|
| `PEER_REVIEW_TIMEOUT_MINUTES` | 10 | how long a peer-review assignment stays reserved for its reviewer |

When the time limit runs out, the assignment is released the next time any student asks for a
review of that problem. After that, the original reviewer can no longer open the answer or submit
a review of it, and anything they were still typing is lost. Set it longer than a review actually
takes. Like the upload caps, a value that is not a positive number logs a warning and falls back
to the default. Tell instructors before shortening it during a term.

The 25MB default was chosen against real data: the largest student answer photo on the Brandeis
deployment was 19.6MB and 99% were under 4MB.

## Setting up Google OAuth credentials

Signing in with Google is the **only** way to log into MLA — there is no username/password
option — so you need your own OAuth client before the app will let you in, even on localhost.

### Use a separate client for local development

Make a second OAuth client for development rather than adding a localhost address to the
production one. A mistake while editing a dev client then cannot break login for real students,
and the dev client can stay in "Testing" mode (see below).

### Steps in the Google Cloud console

At [console.cloud.google.com](https://console.cloud.google.com/):

1. **Create a project** (e.g. `mla-dev`). Any Google account works; it does not have to be an
   institutional one.
2. **Google Auth Platform → Branding** — set an app name and a support email. You see this on
   your own consent screen, so anything sensible is fine for a dev client.
3. **Google Auth Platform → Audience** — choose **External**. For a dev client you can leave the
   publishing status as **Testing** and add your own Google account under *Test users*. Testing
   mode is capped at 100 users, which is irrelevant when you are the only one logging in.
   (A production deployment must be published — see the note at the end of this section.)
4. **Google Auth Platform → Clients → Create client**
   - Application type: **Web application**
   - Name: anything, e.g. `mla-local`
   - **Authorized redirect URIs** — add both of these, exactly as written:
     ```
     http://localhost:5500/login/authorized
     http://127.0.0.1:5500/login/authorized
     ```
   - **Authorized JavaScript origins** — leave empty. MLA uses the server-side OAuth flow, so
     no browser-side origin is involved.
5. Copy the generated **Client ID** and **Client secret** into `CLIENT_ID` and `CLIENT_SECRET`
   in your `.env`, and set `CALLBACK_URL` to whichever of the two URIs you actually browse to.

### Details that will cost you an afternoon if you get them wrong

- **The redirect URI must match `CALLBACK_URL` character for character**, including the port and
  with no trailing slash. A mismatch fails at Google with `redirect_uri_mismatch`, before your
  app is ever reached, so nothing shows up in the server log. The path is `/login/authorized`.
- **`localhost` and `127.0.0.1` are different strings to Google** even though they are the same
  machine. Registering one does not register the other — that is why both are listed above.
- **`http://` is allowed here only because these are loopback addresses.** Every other redirect
  URI must be `https://`. This is why local development needs no TLS setup.
- **The port must be 5500** unless you override it. `bin/www` defaults to 5500 (it reads
  `process.env.PORT` first), so if you set `PORT` to something else, register that port instead.
- **Set `ADMIN_EMAIL` to the Google address you actually sign in with.** Admin rights are a
  normalized email comparison against the logged-in account's email; a different address is silent — the app works,
  the admin screens simply never appear.
- **Only the `profile` and `email` scopes are requested.** Both are non-sensitive, so Google
  requires no verification review and users see no "unverified app" warning. Adding a scope such
  as Drive, Calendar, or Gmail would trigger verification *and* re-impose the 100-user testing
  cap, which breaks login for everyone at once.

### Testing flows that need more than one student

Because password login does not exist, exercising anything multi-user — peer review, grading
queues — means signing in with a different Google account (a second personal account works, and
Chrome profiles or an incognito window make switching easy). Add each test account to a course
roster first; personal Google accounts cannot provision themselves. There is deliberately no way to
create a fake local user; a route that did this was removed because it allowed anyone on the
internet to set a password on an existing account and take it over.

### Sign-in admission

Google must return a verified email address. Sign-in then requires either Google's hosted-domain
claim `hd` to equal `brandeis.edu`, an existing user with a CourseMember or Instructor record,
or an email matching `ADMIN_EMAIL`. An existing User row alone does not admit an outside account.
Instructor approval and course permissions are checked separately after sign-in.

Email comparison ignores case and surrounding whitespace. New users store normalized emails;
admitted existing users normalize their stored email at login while retaining their IDs and
course records. Grade-CSV imports also normalize email case and surrounding whitespace.
Duplicate email records resolve only when exactly one has the authenticated Google subject ID; unresolved
duplicates need administrator assistance. See [OAuth admission and validation](oauth-hardening.md)
for upgrade checks.

### For a production deployment

Same steps, with three differences: register the real `https://` callback URL instead of the
loopback ones, set the publishing status to **In production** on the Audience page so sign-in is
not capped at 100 users, and expect the consent screen to show your deployment's hostname rather
than the app name unless you have completed Google's brand verification (which requires proving
ownership of the domain in Google Search Console).

## Deploying to the cloud

### Express and request parsing

MLA uses Express 5 and body-parser 2. JSON and URL-encoded forms are parsed once,
before authentication, with the existing default 100 KiB limit and
`extended: false`. Multipart uploads still use multer and their separate limits.
Parser errors render the application error page with their 400/413 status even
when authentication has not run. These pages explain that the submission was
too large or unreadable and that the user may still be signed in, without
showing login/logout navigation. Session initialization still follows parsing;
moving it earlier is a separate follow-up. Rejected promises returned by async
handlers now reach the application error handler automatically. The handler
forwards errors if headers were already sent. Server errors show a generic
message outside development; development retains the original message/stack.
Set `NODE_ENV=production` on production deployments.

Express 5's simple query parser handles MLA's flat selectors (`studentEmail`,
`theStudentId`, `makeupId`, `csv`, `json`, `personal`). Bracket notation no longer
creates nested query objects. Repeated keys remain arrays; identity selectors
must still be single values. The app does not mutate `req.query`. A shared guard
normalizes unparsed bodies to `{}` before routes run, preserving legacy behavior
for requests without a JSON or form content type. Existing browser forms and
course content need no edits.

After deployment, check Google login/logout, student answer text and photo
uploads, staff image replacement, roster/grade CSV imports, exam ZIP downloads,
and JSON/CSV views in a test course. Confirm scripts, styles and Font Awesome
fonts load; static JavaScript is now served as `text/javascript`. Error and
missing-route pages must return their proper statuses. See the upstream
[Express 5 migration guide](https://expressjs.com/en/guide/migrating-5/).

### MongoDB and sessions

MLA uses Mongoose 8 and connect-mongo 5 with the MongoDB 6 driver. The session
store waits for Mongoose to connect, then shares that driver's client and database.
Keep the database name in `MONGODB_URL`; there is no separate session-store URL.
Sessions still use the `sessions` collection, JSON serialization, its native
`expires` TTL index, and a one-day cookie. Keep `SESSION_SECRET` unchanged during
this upgrade so existing signed cookies remain usable. No session purge or data
migration is required for the app's existing unencrypted session format.

The upgrade replaces removed count/deletion APIs and removes obsolete connection
options. Mongoose 8 keeps unknown query fields rather than stripping them, and
ObjectId strings must be 24 hexadecimal characters. MLA's URL-ID checks already
require that format. OAuth already uses promise-based model calls. Instructor
content and course roles require no edits for this upgrade.

After deployment, check the database host/name startup messages and the absence
of connection or session-index errors. In a test course, verify an existing
signed-in browser session, a fresh Google login, and logout; after restarting the
app, the signed-in session should still work. Also open statistics, the student
course page and PRA mastery totals, then promote a rostered test student to TA
and confirm their membership in a second test course is unchanged. Automated
tests use real Mongoose models, Passport and connect-mongo with synthetic
collection I/O; a deployed smoke test is still needed for Atlas connectivity,
index permissions and persistence.

See the upstream [Mongoose 7 migration guide](https://mongoosejs.com/docs/migrating_to_7.html),
[Mongoose 8 migration guide](https://mongoosejs.com/docs/migrating_to_8.html), and
[connect-mongo migration guide](https://github.com/jdesboeufs/connect-mongo/blob/v5.1.0/MIGRATION_V4.md).

### Answer image storage

Deployed instances require `UPLOAD_TO=AWS`. Before upgrading an existing
instance, follow the [private-image cutover and authorization checks](authorization-fix.md#deployment-required-storage-cutover).
The server verifies all four bucket-level S3 Block Public Access settings before
listening, and its IAM principal needs `s3:GetBucketPublicAccessBlock` in addition
to object access. Local image storage is supported only as an explicitly enabled,
loopback-only testbed; it is not a deployment option.

We currently use render.com to deploy our app from the github repository.
We use MONGODB Atlas for database access
and we use AWS S3 for storing images. You can specify an AWS S3 bucket by
setting UPLOAD_TO to be "AWS" and adding the following fields to your .env file:
```
ADMIN_EMAIL=GMAIL OF THE ADMINISTRATOR
SESSION_SECRET=GENERATE ONE WITH: openssl rand -base64 32
CLIENT_ID=GOOGLE_CLIENT_ID_GOES_HERE
CLIENT_SECRET=GOOGLE_SECRET_GOES_HERE
CALLBACK_URL=https://YOUR-DEPLOYED-HOSTNAME/login/authorized
MONGODB_URL=YOUR MONGODB SERVER 
UPLOAD_TO = "AWS" # "LOCAL" or "AWS"
AWS_SECRET_ACCESS_KEY = 'YOUR KEY GOES HERE'
AWS_ACCESS_KEY_ID = 'YOUR KEY GOES HERE'
AWS_REGION = 'YOUR REGION'
AWS_BUCKET_NAME = 'YOUR BUCKET NAME'   
```

S3 storage uses AWS SDK v3 (`@aws-sdk/client-s3`) and multer-s3 3. The app passes
the access key, secret key, and region above to its S3 client. The SDK upgrade
requires no environment-variable changes. Uploads retain private ACLs and the
existing size limits; larger files use managed multipart uploads. Image reads
stream the SDK response body through the authenticated image route.

After deploying an SDK update, verify uploads in a test course using a rostered
personal Google account: upload a small image, then an image larger than 5 MiB
and below `MAX_UPLOAD_MB`. Confirm both display through the protected image
route. Replace a reviewed answer's image as staff and confirm its answer ID and
reviews survive. Also confirm an oversized upload reports 413 and retains the
existing answer. Startup must still pass the bucket-privacy check. The automated
suite exercises these paths with an in-memory S3 transport, but a deployed smoke
test is needed to verify actual bucket permissions and connectivity.

Contact the MLA team if you need some help deploying the app!

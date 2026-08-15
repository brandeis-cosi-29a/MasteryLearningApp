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
UPLOAD_TO = "LOCAL" # "LOCAL" or "AWS"
```
the administrator has special privileges, including being able to add or remove instructors and to see all courses on the app.

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
  string comparison against the logged-in account's email; a mismatch is silent — the app works,
  the admin screens simply never appear.
- **Only the `profile` and `email` scopes are requested.** Both are non-sensitive, so Google
  requires no verification review and users see no "unverified app" warning. Adding a scope such
  as Drive, Calendar, or Gmail would trigger verification *and* re-impose the 100-user testing
  cap, which breaks login for everyone at once.

### Testing flows that need more than one student

Because password login does not exist, exercising anything multi-user — peer review, grading
queues — means signing in with a different Google account (a second personal account works, and
Chrome profiles or an incognito window make switching easy). There is deliberately no way to
create a fake local user; a route that did this was removed because it allowed anyone on the
internet to set a password on an existing account and take it over.

### For a production deployment

Same steps, with three differences: register the real `https://` callback URL instead of the
loopback ones, set the publishing status to **In production** on the Audience page so sign-in is
not capped at 100 users, and expect the consent screen to show your deployment's hostname rather
than the app name unless you have completed Google's brand verification (which requires proving
ownership of the domain in Google Search Console).

## Deploying to the cloud
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
Contact the MLA team if you need some help deploying the app!

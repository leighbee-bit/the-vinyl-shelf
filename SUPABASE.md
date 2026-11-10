# Turning on community reviews

Ratings and reviews work straight away, saved on each person's device. To let everyone see each other's
reviews, connect a free [Supabase](https://supabase.com) project. It takes about 10 minutes, and you only do it once.

## 1. Create the project
1. Sign up at https://supabase.com and click **New project**. Any name works (e.g. `vinyl-shelf`).
   Pick a region near you and save the database password somewhere safe (you won't need it in the app).
2. Wait a minute for it to finish setting up.

## 2. Create the tables
1. In the project, open **SQL Editor → New query**.
2. Paste everything in [`supabase/schema.sql`](supabase/schema.sql) and click **Run**.
   This creates `profiles` (display names) and `reviews`, with rules so that anyone can read reviews
   but people can only add, edit or delete their own.

## 3. Set up sign-in links
1. Open **Authentication → Sign In / Providers** and make sure **Email** is enabled.
2. Open **Authentication → URL Configuration**:
   - **Site URL**: `https://leighbee-bit.github.io/the-vinyl-shelf/`
   - **Redirect URLs**: add `https://leighbee-bit.github.io/the-vinyl-shelf/` and `http://127.0.0.1:8888/`

## 4. Connect the app
1. Copy the **Project URL** (Project Settings → Data API) and the **publishable key** (Project Settings → API Keys, starts with `sb_publishable_`) into [`config.js`](config.js):
   ```js
   window.TVS_CONFIG = {
     supabaseUrl: 'https://abcdefgh.supabase.co',
     supabaseAnonKey: 'sb_publishable_…',
   };
   ```
   Both are meant to be public. Never paste a **secret** key (`sb_secret_…`) or the legacy **service_role** key here. An older `eyJ…` anon key also works, but Supabase retires those in early 2027.
2. Commit and push `config.js` to the repo like any other file (no Supabase GitHub integration needed). In the app, open **Settings → Profile & reviews**, pick a display name, enter your email,
   and click the link Supabase sends you. Reviews you'd already written on that device are shared automatically.

## 5. Brand the sign-in email (optional)
Supabase only lets you edit email templates once you send through your own email service
(**Authentication → Emails → SMTP Settings**, e.g. ImprovMX or Resend on your domain). Then:
1. Open **Authentication → Emails → Templates**.
2. In **Magic Link** set the subject to `Your sign-in link for The Vinyl Shelf` and paste
   [`supabase/email-sign-in.html`](supabase/email-sign-in.html) into the body.
3. Do the same in **Confirm signup** (subject: `Welcome to The Vinyl Shelf — confirm your email`).
   New listeners get this one on their first sign-in.
4. Set `emailSender` in [`config.js`](config.js) to your sender name, so the app tells people what to look for.

## Good to know
- **Email limits:** Supabase's built-in email sender only allows a few sign-in emails per hour. That's fine for
  you and friends; for more people, add your own email service under **Authentication → SMTP Settings**.
- **Moderation:** people can only change their own reviews. To remove someone else's, delete the row in
  **Table Editor → reviews**.
- **Free tier:** the free plan is plenty for this, but Supabase pauses projects that go unused for a week —
  open the dashboard to wake it up.

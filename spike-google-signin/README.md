# Spike: "type your email and you're in" for Google accounts

**Goal:** a user types `name@gmail.com` (or a Google Workspace address) and ends up connected,
without opening Google Cloud Console.

**Today:** every user creates their own Google OAuth app (project → enable Calendar API → consent
screen → test user → Desktop client ID + secret) and pastes the ID and secret into BRAIN2
(`backend/brain2/accounts/providers.py`). That takes 10–15 minutes and loses most people. Even
when it works, the app is in *Testing*, so the sign-in expires every 7 days.

## Hard limits (things no design can avoid)

1. **BRAIN2 can never take the Google password.** Google blocks password sign-in in embedded
   webviews (`disallowed_useragent`). Google Calendar's CalDAV endpoint rejects Basic auth (401),
   and since March 2025 Google requires OAuth for third-party Calendar access. So the email alone
   can't log anyone in: at least one Google consent page in the browser is unavoidable.
   2-step verification and passkeys run on Google's page, which is the right place for them.
2. **The OAuth app has to belong to someone.** Either each user owns one (today) or BRAIN2 ships
   one. That's the whole trade-off.

So the realistic target is: **type email → browser opens already on that account → click
"Allow" → done.** One page and one click.

## Options

| | Option | User steps | Who pays the cost | Verdict |
|---|---|---|---|---|
| A | **BRAIN2 ships its own Google OAuth client** (Desktop type, PKCE + loopback; what we already do, just with a built-in client ID) | email → Allow | Maintainer: one Google Cloud project plus one-time app verification | **Recommended** |
| B | Keep bring-your-own client and improve the guide (deep links, screenshots, a wizard) | ~10 minutes in Cloud Console | Every user | Keep it as the *Advanced* fallback |
| C | Device code flow (enter a code at google.com/device) | email → code → Allow | Same as A | No gain over A; Google limits the scopes this flow allows, and I couldn't confirm Calendar is on that list |
| D | Paste the calendar's "secret address in iCal format" (ICS URL) | Google Calendar settings → copy URL → paste | Nobody | Zero setup, but read-only, one calendar at a time, and not "email only". Good extra for people who refuse OAuth |
| E | Collect the password or an app password | email + password | — | Impossible (see hard limit 1) and against BRAIN2's security rules |

### Why A fits BRAIN2's principles

- **No company servers:** the sign-in still runs on the user's machine. The browser redirects to
  BRAIN2's own `127.0.0.1` loopback, and tokens go straight into the OS keychain. The shipped
  client ID is just an identifier; Google treats Desktop "client secrets" as public. This is how
  Thunderbird, rclone and GNOME Online Accounts work.
- **No data ever reaches the maintainer.** The Cloud project only sees aggregate quota numbers.
- **Free:** `calendar.readonly` is a *sensitive* scope, not a *restricted* one, so verification
  costs nothing. Restricted scopes (reading Gmail, for the future Messages module) need a paid
  annual CASA security assessment. Plan for that separately.

### What A needs from the maintainer (one-time)

1. A Google Cloud project named "BRAIN2". Enable the Calendar API and create an OAuth client of
   type **Desktop app**.
2. Set up the consent screen: External, app name, logo (`res/`), support email, scopes
   `openid email calendar.readonly`.
3. Set up a public domain (GitHub Pages works) for:
   - a homepage that describes BRAIN2;
   - a privacy policy ("data stays on your device; tokens in your OS keychain; nothing sent to
     the BRAIN2 developers");
   - domain ownership verified in Search Console.
4. Request **verification** (switch the publishing status to *In production*). This needs a
   short YouTube video showing the consent screen and how calendar data is used, and a written
   justification for the scope. Google usually takes days to a few weeks.
   - Until it's verified, users see an "unverified app" warning, the app is capped at 100 users,
     and test-mode tokens expire after 7 days. That's fine for a beta.
5. Ship the client ID and secret in the build, injected from CI secrets in `release.yml` and
   kept out of git so forks don't inherit them.

**Risks:**
- Someone could copy the client ID. The worst case is quota abuse or Google suspending the
  client, which would break sign-in for all users of the official build.
- Mitigations:
  - Keep option B (your own client) as the fallback under *Advanced*.
  - Let forks and dev builds use their own client.
  - Watch quota in Cloud Console.

## The "email first" flow (works with any of the options)

One input field for all account providers: the user types an email and BRAIN2 picks the provider.

1. **Detect the provider:**
   - `gmail.com` / `googlemail.com` → Google.
   - `outlook.com`, `hotmail.com`, `live.com` → Microsoft.
   - `icloud.com`, `me.com`, `mac.com` → Apple.
   - Any other domain → look up its **MX records**:
     - `*.google.com` / `googlemail.com` → Google Workspace.
     - `*.mail.protection.outlook.com` → Microsoft 365.
     - `*.mail.icloud.com` → iCloud custom domain.
   - Still unknown → show the provider picker.
   - This is what Thunderbird's autoconfig does. The backend needs `dnspython`, or a DNS-over-HTTPS
     query; that query reveals the domain to the DoH provider, so prefer the OS resolver.
2. **Google:** open the browser at the auth URL with **`login_hint=<email>`**.
   - Google goes straight to that account, or asks only for its password or passkey if the user
     isn't signed in to it yet.
   - Drop `select_account` from `prompt` (keep `consent`) so the account chooser doesn't appear.
   - For Workspace domains, add `hd=<domain>`.
3. **After sign-in:** check that the `email` in the ID token matches what the user typed. If not,
   say "you signed in as X instead" and let them keep it or retry.
4. **Microsoft and Apple fit the same box:**
   - Microsoft takes `login_hint` too; it has the same shared-client question (publisher
     verification through a free Microsoft Partner account).
   - Apple goes to the existing app-password form with the email already filled in.

The code change is small: `auth_url()` gains `login_hint`/`hd`, and the UI adds one email box
before the provider picker. Multiple accounts per provider already work.

## Recommendation

1. **Now, no Google paperwork needed:** add the email-first box, provider detection and
   `login_hint`, in the current bring-your-own-client mode. This already removes the account
   chooser and the provider picker.
2. **Before launch:** create the BRAIN2 Google Cloud project and start verification. It's the
   longest lead time (weeks), so start early. Ship the built-in client from CI, with
   bring-your-own as *Advanced*.
3. **Optional:** add an "ICS link" source (option D) for read-only calendars without OAuth.
4. **Later:** Gmail access means restricted scopes and the paid CASA assessment. Decide that
   separately when the Messages module needs it.

## Open questions for the maintainer

- Is it OK for the official builds to carry a BRAIN2-owned Google Cloud project? It's not a
  server, but it is an account in the maintainer's name.
- Which domain will host the homepage and privacy policy (e.g. a GitHub Pages site for the repo)?
- Are Microsoft personal and work accounts in scope for the same treatment now?

## Sources

- Google CalDAV guide (Basic auth → 401): https://developers.google.com/calendar/caldav/v2/guide
- Workspace "less secure apps → OAuth" (March 2025): https://knowledge.workspace.google.com/admin/sync/transition-from-less-secure-apps-to-oauth
- Calendar scopes: https://developers.google.com/calendar/api/auth
- Device flow (limited scopes): https://developers.google.com/identity/protocols/oauth2/limited-input-device
- App audience / testing limits: https://support.google.com/cloud/answer/15549945

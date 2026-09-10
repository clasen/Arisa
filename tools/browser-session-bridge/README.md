# Browser Session Bridge

A Chrome/Brave Manifest V3 extension and Arisa tool for intentionally sharing the active site's applicable cookies from a dedicated browser profile.

## Recommended profile

Create a separate Chrome or Brave profile named **Arisa**. Install the extension and log in to sites only inside that profile. Whenever possible, use dedicated, non-personal accounts with only the access Arisa needs. This keeps personal browsing separate and limits the scope of sessions intentionally shared with Arisa.

## Normal installation

The intended release path is the Chrome Web Store, which also works in Brave and provides signed automatic updates. After installing it:

1. Ask Arisa for a browser-profile setup link.
2. Open the link in the dedicated **Arisa** browser profile.
3. Open the extension and choose **Connect this profile**.
4. Approve access to the bridge endpoint once.

The popup records consent before requesting permission. A Manifest V3 service worker completes activation independently of the popup, including after the permission prompt closes it. Permission events and a one-minute recovery alarm resume pending work after worker suspension. Connection retries are bounded to three attempts until setup expiry. Reopening the same link preserves pending consent instead of resetting it. Session capture uses the original tab and origin for at most two minutes, with grant ownership retained so recovery can remove temporary access without removing pre-existing permissions. A completed activation may be replayed until link expiry without creating another profile or reviving a revoked one.

The setup link expires, is consumed after one activation, and keeps its temporary activation credential in the URL fragment so it is not sent in HTTP requests or referrers. The permanent profile credential is returned inside an AES-256-GCM encrypted response and is never present in the setup URL. Bridge endpoints require HTTPS; HTTP is allowed only on localhost. Requests have a 15-second timeout and reject redirects. Bridge endpoints may use a scoped HTTPS base path, such as `https://example.com/session-bridge`, when deployed behind a reverse proxy.

## Development fallback

1. Generate `arisa-session-bridge.zip` with the tool's `extension` action.
2. Unzip it into a permanent folder.
3. Open `chrome://extensions` or `brave://extensions`.
4. Enable **Developer mode**.
5. Choose **Load unpacked** and select the folder.
6. Pin **Arisa Session Bridge**.

## Share a session

1. Open an authenticated site in the dedicated profile.
2. Open the extension.
3. Choose **Send current session**.

Arisa immediately confirms receipt before continuing any pending browser work.

The extension uses `activeTab` for the selected site rather than permanent access to every site. It does not read site localStorage, sessionStorage, or IndexedDB. When the user sends a session, it requests host access only while reading applicable cookies, then removes access. Instagram and Google temporarily include their parent-domain wildcard so Chrome can expose authentication cookies scoped to `.instagram.com` or `.google.com`; unrelated sites remain exact-host only. A send from any `*.google.com` product also stores a separate `accounts.google.com` cookie session because Google authentication may redirect away before that host can be shared manually. The bridge admits those distinct resources consecutively. Duplicate encrypted imports or operation identifiers return the saved result without importing or notifying twice. Receipt records contain no cookies, expire after 24 hours, and are cleaned during subsequent imports. Captures must be at most ten minutes old. It does not collect host-only cookies from other Google products unless that product is the active site. Persistent host permission is retained only for the configured bridge endpoint. Session payloads use AES-256-GCM, remain chat-scoped, and never expose stored session values in tool output.

Sessions are keyed by both the paired browser profile and the site domain. Peter and Amy can therefore share the same domain without overwriting each other. `list` returns the profile label and `deviceId`; `open` and `delete` require `deviceId` whenever more than one profile has shared that domain.

After an authenticated browser action, the bridge stores refreshed cookie values only when they still apply to the originally shared site and profile. It never expands the session to sibling hosts, unrelated domains, or another paired profile. This can extend a session but cannot override provider-controlled expiry or reauthentication.

The `open` action now uses `lightpanda` by default. It opens or reuses the site's authenticated Lightpanda session, navigates to the requested same-site URL, and returns bounded title and body text while leaving the session reusable. Pass `engine=chromium` explicitly for an incompatible target. A Lightpanda failure is returned as-is and never triggers an automatic Chromium fallback.

Sharing grants Arisa the same access as the selected browser session. Log out, use **Forget**, or ask Arisa to delete the stored session and revoke the browser profile. Delete removes both working and source cookie copies; revocation also clears import receipts. Non-secret revocation markers make repeated Forget requests safe after an interrupted response. If revocation is not confirmed, Forget keeps the local credential for retry. The bridge does not bypass login, CAPTCHA, verification, approval, or anti-bot controls.

## Chrome Web Store reviewer access

The `reviewer-setup` action creates one durable, revocable reviewer URL for confidential Chrome Web Store test instructions. Its credential remains in the URL fragment. Opening it mints a normal 10-minute, single-use enrollment and redirects to the regular connection page. Creating a new reviewer URL replaces the previous one; `reviewer-revoke` invalidates it without affecting paired user profiles.

## Tests

Run `npm test` for unit and HTTP integration tests. Run `RUN_BROWSER_TESTS=1 npm test` to include the Chromium worker/popup lifecycle test. That test closes the extension page during a real activation request and checks persisted connection state after reopening; it stubs the permission API and does not replace a manual Chrome/Brave permission-prompt check.

## Daemon availability

The bridge receives browser imports without a preceding Arisa tool request, so its managed daemon auto-starts and does not use idle shutdown. Runtime infrastructure stays global while imported sessions remain chat-scoped.

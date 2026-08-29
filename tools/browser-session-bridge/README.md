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

The setup link expires, is consumed after one activation, and keeps its temporary activation credential in the URL fragment so it is not sent in HTTP requests or referrers. The permanent profile credential is returned inside an AES-256-GCM encrypted response and is never present in the setup URL. Bridge endpoints may use a scoped HTTPS base path, such as `https://example.com/session-bridge`, when deployed behind a reverse proxy.

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

The extension uses `activeTab` for the selected site rather than permanent access to every site. When the user sends a session, it requests host access for that active site only while reading its applicable cookies, then removes access. Persistent host permission is retained only for the configured bridge endpoint. Session payloads use AES-256-GCM, remain chat-scoped, and never expose cookie values in tool output.

After an authenticated browser action, the bridge stores refreshed cookie values only when they still apply to the originally shared site. It never expands the session to sibling hosts or unrelated domains. This can extend a session but cannot override provider-controlled expiry or reauthentication.

The `open` action now uses `lightpanda` by default. It opens or reuses the site's authenticated Lightpanda session, navigates to the requested same-site URL, and returns bounded title and body text while leaving the session reusable. Pass `engine=chromium` explicitly for an incompatible target. A Lightpanda failure is returned as-is and never triggers an automatic Chromium fallback.

Sharing grants Arisa the same access as the selected browser session. Log out, use **Forget**, or ask Arisa to delete the stored session and revoke the browser profile. The bridge does not bypass login, CAPTCHA, verification, approval, or anti-bot controls.

## Chrome Web Store reviewer access

The `reviewer-setup` action creates one durable, revocable reviewer URL for confidential Chrome Web Store test instructions. Its credential remains in the URL fragment. Opening it mints a normal 10-minute, single-use enrollment and redirects to the regular connection page. Creating a new reviewer URL replaces the previous one; `reviewer-revoke` invalidates it without affecting paired user profiles.

## Daemon availability

The bridge receives browser imports without a preceding Arisa tool request, so its managed daemon auto-starts and does not use idle shutdown. Runtime infrastructure stays global while imported sessions remain chat-scoped.

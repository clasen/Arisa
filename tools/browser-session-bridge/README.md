# Browser Session Bridge

A Chrome/Brave Manifest V3 extension and Arisa tool for intentionally sharing the active site's applicable cookies from a dedicated browser profile.

## Recommended profile

Create a separate Chrome or Brave profile named **Arisa**. Install the extension and log in to sites only inside that profile. This keeps personal browsing separate from sessions intentionally shared with Arisa.

## Normal installation

The intended release path is the Chrome Web Store, which also works in Brave and provides signed automatic updates. After installing it:

1. Ask Arisa for a browser-profile setup link.
2. Open the link in the dedicated **Arisa** browser profile.
3. Open the extension and choose **Connect this profile**.
4. Approve access to the bridge endpoint once.

The setup link expires, is consumed after one activation, and keeps its temporary activation credential in the URL fragment so it is not sent in HTTP requests or referrers. The permanent profile credential is returned inside an AES-256-GCM encrypted response and is never present in the setup URL.

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

The extension uses `activeTab` for the selected site rather than permanent access to every site. It requests persistent host permission only for the configured bridge endpoint. Session payloads use AES-256-GCM, remain chat-scoped, and never expose cookie values in tool output.

Sharing grants Arisa the same access as the selected browser session. Log out, use **Forget**, or ask Arisa to delete the stored session and revoke the browser profile. The bridge does not bypass login, CAPTCHA, verification, approval, or anti-bot controls.

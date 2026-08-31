# Arisa Session Bridge Privacy Policy

Last updated: August 30, 2026

Arisa Session Bridge has one purpose: to let a user intentionally share the active site's browser session with an Arisa instance they control.

## Data processed

When the user chooses **Send current session**, the extension processes:

- the active site's hostname and origin
- cookies applicable to that active URL
- localStorage and sessionStorage belonging to that active page
- the capture time
- a revocable bridge-device identifier

On Chrome-restricted pages such as the extensions gallery, page scripting is prohibited, so the extension omits web storage and continues only with applicable cookies. The extension does not collect browsing history, keystrokes, or sessions for inactive sites. It requests host access only during this explicit action and removes that access after reading cookies and web storage. Instagram and Google also require temporary access to their parent domain so Chrome can expose authentication cookies shared across their subdomains; unrelated sites remain exact-host only.

## Transfer and storage

Session data is encrypted with AES-256-GCM before transfer to the bridge endpoint configured by the user. The receiving Arisa instance stores imported sessions within that user's chat-scoped state. Cookie values are not returned in Arisa tool results.

The extension stores its bridge endpoint, device identifier, and device secret locally in the dedicated browser profile. A temporary setup credential expires, is single-use, arrives in a URL fragment so it is not sent in HTTP requests or referrers, and may be held in extension-local storage only until activation succeeds or the credential expires. If a site-permission prompt interrupts a send, the extension retains only the pending tab identifier and origin for up to two minutes so reopening the popup can resume it.

## Sharing and sale

The extension does not sell data, use data for advertising, or transfer data to unrelated third parties. Data goes only to the Arisa bridge endpoint explicitly paired by the user.

## Retention and deletion

Users can revoke the browser profile with **Forget**, revoke it from Arisa, delete an imported site session, or log out of the source site. Retention on the receiving server is controlled by the user operating that Arisa instance.

## Security boundary

Sharing a browser session grants the receiving Arisa instance the same access represented by that session. Users should install the extension only in a dedicated browser profile. The extension does not bypass login, CAPTCHA, verification, approval, or anti-bot controls.

## Contact

Privacy questions may be submitted through the official Arisa project repository: https://github.com/clasen/Arisa

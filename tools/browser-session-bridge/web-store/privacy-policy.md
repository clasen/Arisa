# Arisa Session Bridge Privacy Policy

Last updated: September 10, 2026

Arisa Session Bridge has one purpose: to let a user intentionally share the active site's browser session with an Arisa instance they control.

## Data processed

When the user chooses **Send current session**, the extension processes:

- the active site's hostname and origin
- cookies applicable to that active URL
- the capture time
- a revocable bridge-device identifier
- bounded standard request metadata sent automatically by the browser: User-Agent, language, and available client hints

The extension does not read site localStorage, sessionStorage, or IndexedDB. It does not collect browsing history, keystrokes, or sessions for inactive sites. It requests host access only during this explicit action and removes that access after reading applicable cookies. Instagram and Google also require temporary access to their parent domain so Chrome can expose authentication cookies shared across their subdomains; unrelated sites remain exact-host only. When the active site is a `*.google.com` product, the extension also stores a separate session containing cookies applicable to `accounts.google.com`, because Google authentication may redirect away before that host can be shared manually. It does not collect host-only cookies from other Google products unless that product is the active site.

## Transfer and storage

Session data is encrypted with AES-256-GCM before transfer to the bridge endpoint configured by the user. The receiving Arisa instance stores imported sessions and bounded browser request metadata within that user's chat-scoped state. Cookie values are not returned in Arisa tool results. The bridge does not persist the network address as browser identity metadata.

The extension stores its bridge endpoint, device identifier, and device secret locally in the dedicated browser profile. A temporary setup credential expires, is single-use, arrives in a URL fragment so it is not sent in HTTP requests or referrers, and may be held in extension-local storage only until activation succeeds or the credential expires. A background service worker completes user-authorized operations even if the popup closes. It retains the pending tab identifier, origin, device identifier, operation identifier, capture time, and acquired permission patterns for up to two minutes. A recovery alarm resumes consented setup or cleans expired work when the browser runs; it does not start new shares. Pending records never contain cookies. The bridge retains cookie-free import receipts for 24 hours, cleaning expired receipts on subsequent imports, and non-secret revocation markers for retry safety.

## Sharing and sale

The extension does not sell data, use data for advertising, or transfer data to unrelated third parties. Data goes only to the Arisa bridge endpoint explicitly paired by the user.

## Retention and deletion

Users can revoke the browser profile with **Forget**, revoke it from Arisa, delete an imported site session, or log out of the source site. Deletion removes both working and source cookie copies. If server revocation is not confirmed, Forget retains the local credential so the user can retry. Retention on the receiving server is controlled by the user operating that Arisa instance.

## Security boundary

Sharing a browser session grants the receiving Arisa instance the same access represented by that session. Users should install the extension only in a dedicated browser profile. The extension does not bypass login, CAPTCHA, verification, approval, or anti-bot controls.

## Contact

Privacy questions may be submitted through the official Arisa project repository: https://github.com/clasen/Arisa

# Arisa Session Bridge Privacy Policy

Last updated: August 16, 2026

Arisa Session Bridge has one purpose: to let a user intentionally share the active site's applicable browser cookies with an Arisa instance they control.

## Data processed

When the user chooses **Send current session**, the extension processes:

- the active site's hostname and origin
- cookies applicable to that active URL
- the capture time
- a revocable bridge-device identifier

The extension does not collect browsing history, keystrokes, form contents, or cookies for inactive sites. It requests host access for the active site only during this explicit action and removes that access after reading the applicable cookies.

## Transfer and storage

Session data is encrypted with AES-256-GCM before transfer to the bridge endpoint configured by the user. The receiving Arisa instance stores imported sessions within that user's chat-scoped state. Cookie values are not returned in Arisa tool results.

The extension stores its bridge endpoint, device identifier, and device secret locally in the dedicated browser profile. A temporary setup credential expires, is single-use, and is carried in a URL fragment so it is not sent in HTTP requests or referrers.

## Sharing and sale

The extension does not sell data, use data for advertising, or transfer data to unrelated third parties. Data goes only to the Arisa bridge endpoint explicitly paired by the user.

## Retention and deletion

Users can revoke the browser profile with **Forget**, revoke it from Arisa, delete an imported site session, or log out of the source site. Retention on the receiving server is controlled by the user operating that Arisa instance.

## Security boundary

Sharing a browser session grants the receiving Arisa instance the same access represented by that session. Users should install the extension only in a dedicated browser profile. The extension does not bypass login, CAPTCHA, verification, approval, or anti-bot controls.

## Contact

Privacy questions may be submitted through the official Arisa project repository: https://github.com/clasen/Arisa

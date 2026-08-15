# Chrome Web Store listing

## Name

Arisa Session Bridge

## Summary

Intentionally share the active site's session with your own Arisa assistant from a dedicated browser profile.

## Description

Arisa Session Bridge lets you explicitly send the cookies applicable to the active site to an Arisa instance you control.

Use it in a dedicated Chrome or Brave profile named Arisa. Connect the profile once with a temporary, single-use setup link. After that, open a logged-in site, select the extension, and choose **Send current session**.

The extension:

- acts only after you open its popup and choose an action
- uses active-tab access for the selected site
- requests persistent host access only for your configured Arisa bridge endpoint
- encrypts session payloads with AES-256-GCM
- never displays or returns cookie values through Arisa tool output
- supports local and server-side device revocation
- does not bypass login, CAPTCHA, verification, approval, or anti-bot controls

A separate browser profile is strongly recommended because a shared session grants Arisa the same access as that browser session.

## Category

Productivity

## Language

English

## Permission justifications

- `activeTab`: identify the site selected by the user and temporarily access only that site after the extension action is invoked
- `cookies`: read cookies applicable to the selected site when the user chooses **Send current session**
- `storage`: retain the revocable bridge-device credential in the dedicated browser profile
- optional HTTP/HTTPS host access: communicate with the exact bridge endpoint approved during initial setup; the extension requests only that origin

# deQR privacy policy

_Last updated: 2026-09-09_

deQR does not collect, transmit, or sell any data. There is no server, no
account, and no analytics.

## What deQR does with page content

deQR reads the pixels of images on the pages you visit in order to detect and
decode QR codes. This happens entirely inside your browser.

- Decoded QR payloads are shown to you and are never transmitted anywhere.
- Payloads are not written to disk, to logs, or to browser storage.
- deQR makes no network requests of its own. Its QR decoder is bundled with the
  extension, so nothing is fetched at runtime, and the extension works offline.
- No URL, domain, image, or page address is ever sent to any service. deQR does
  **not** check links against any reputation or safe-browsing API, by design:
  doing so would hand your browsing to a third party.

## What deQR stores

Only your own settings, in your browser's local extension storage:

- the list of image origins you have chosen to allow,
- the list of sites where you have turned scanning off,
- two display preferences (deep scan, and whether to unmask secrets immediately).

These stay on your device. They are not synced by deQR and not readable by the
websites you visit.

## Permissions and why they exist

- **Access to the pages you visit** - required to find QR codes in page images.
  QR codes can appear on any page, so the extension cannot know in advance which
  pages to look at. It uses this access only to read image pixels and to show its
  own button and panel.
- **Storage** - the settings listed above.
- **Access to specific image servers (optional, off by default)** - never
  requested when you install deQR. Some sites serve images from a separate
  domain in a way that prevents the extension from reading them at all. If you
  want those images decoded, you can grant access to that one domain from the
  options page. The resulting request is made by your browser to that domain, in
  the ordinary way, and its response is used only to decode the image locally.

## Third parties

None. deQR contains no third-party analytics, advertising, or tracking code, and
loads no remote code.

## Contact

Report problems at https://github.com/alexdonh/deqr/issues.

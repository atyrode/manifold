---
section: Added
issue: 972
---

Plugin authors can opt into an installation-authorized live workshop with `manifold-dev --workshop` or the plugin kit's `devWorkshop` API. Compatible React and CSS edits use the existing source frontend's real Fast Refresh without reinstalling bundles, while compiler-observed server inputs rebuild the complete plugin family before replacing changed bundles, retaining the exact existing installation consent and restarting source admission. Failed compilation leaves the existing backend running; manifest, action-authority, dependency and native changes still require explicit installation review. The workshop retains normal browser sign-in and supports the existing explicit TLS development hostname, while source-only `--fast-refresh` remains credential-free.

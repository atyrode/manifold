---
section: Breaking Changes
issue: 415
---

Server-side plugin URL installation now validates HTTPS and public-unicast destinations at every redirect, pins the resolved TLS peer before sending HTTP, and permits at most five followed redirects within one 30-second deadline. URL credentials and private/reserved destinations are refused; ambient HTTP(S) proxy settings are ignored. Public self-hosted sources remain supported; intentionally private artifacts can still be delivered through the existing local upload drop box. Decoded-byte limits and exact SHA-256 verification remain enforced. This does not restrict a kit client’s own inspection fetch or sandbox installed plugin code.

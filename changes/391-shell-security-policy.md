---
section: Changed
issue: 391
---

Direct-server responses now provide MIME-sniffing protection and a baseline referrer policy without weakening preview sign-in documents. The Caddy examples add one-day, host-only HSTS for HTTPS vhosts while leaving HTTP and localhost development unpinned, with no subdomain or preload commitment. The plugin guidance now explicitly describes hardened Workers' existing network and origin-storage limits; the accompanying CSP design does not activate network confinement.

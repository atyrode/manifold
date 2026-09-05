# Pending changelog fragments

One file per user-visible change, `<issue>-<slug>.md`, consumed by `bun run release` into
`CHANGELOG.md` and rendered until then as the in-app "unreleased" entry. Front matter carries
`section` (`Breaking Changes` | `Added` | `Changed` | `Fixed` | `Removed`) and `issue`; the body
is one user-facing paragraph, no bullets, in the voice of the released sections. The pull request
number is derived at release from the `(#N)` suffix of the squash commit that added the file —
never write it, except `pr:` on a fragment migrated from a bullet that already carried one.
Required for every change a user can see (product, wire, in-app copy, `docs/SELF-HOST.md`);
not for docs-only, process, test or gate-only changes. `bun run changelog:check` refuses a
fragment that does not parse.

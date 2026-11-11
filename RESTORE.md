# Backup of local-only git state: manifold (2026-11-11)

`manifold.bundle` holds every branch, stash and working-tree snapshot that existed only in the local clone
`/home/alex/manifold` on 2026-11-11 (see `MANIFEST.tsv`). Original commits are preserved exactly, with the same SHAs.
The bundle is thin: it needs the history of `origin/main`.

Excluded on purpose: squash-merged branches whose PR head matches the local tip (their content is in the default branch);
`node_modules`; build/cache directories; files named like secrets; untracked files above 20 MB.

## Restore

```sh
git fetch origin refs/backup/2026-11-11/manifold/bundle
git cat-file blob FETCH_HEAD:manifold.bundle > /tmp/manifold.bundle
git bundle verify /tmp/manifold.bundle
git fetch /tmp/manifold.bundle 'refs/backup/2026-11-11/*:refs/backup/2026-11-11/*'
git for-each-ref refs/backup/2026-11-11
```

Stashes: `git stash apply <ref>`. Working-tree snapshots are commits on top of the worktree's HEAD: `git diff <ref>^ <ref>`.

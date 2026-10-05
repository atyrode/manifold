---
section: Breaking Changes
issue: 880
---

Terminal views now earn bounded delivery credit only after their parser finishes, so a slow or stopped reader cannot accumulate an unlimited queue or hold back another view or the PTY. When a view falls beyond its pending window, it recovers from a sequenced retained-screen snapshot and shows an accessible notice that earlier output and scrollback may be incomplete; keyboard input to that view pauses until the retained screen has loaded, while the view keeps its size, and Catch up can replace a stopped view's parser deliberately. A view whose terminal ends while output is still held for it is told that its output is incomplete. Protocol 57 requires matching SDK and plugin bundles: terminal attach/detach now identify each viewport, and consumers acknowledge completed parsing with the delivery incarnation and ordinal. Machine/instance compatibility and native host floors are unchanged, and no terminal recording is created.

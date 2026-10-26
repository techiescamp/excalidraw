# Guidelines

**Read [DEVELOPMENT.md](DEVELOPMENT.md) before changing anything.** It defines
the branch model, the checks that must pass, how releases are cut and deployed,
and the operational rules that exist because breaking them took the site down.
It applies to every agent and every person working here.

In short: branch per change, never commit to `main` or `develop`, write a test
that fails before your fix, run every check in its section 4, and never report
success you have not read back from the system you changed.

## Code style

- For new DOM/browser API usage, use `app.ownerDocument` and `app.ownerWindow` instead of globals; without `app`, derive them from the mounted node's `ownerDocument` and its `defaultView`.
- When overriding properties of an existing type, prefer `Merge<Base, Overrides>` from `@excalidraw/common/utility-types` over `Omit<Base, keyof Overrides> & Overrides`.

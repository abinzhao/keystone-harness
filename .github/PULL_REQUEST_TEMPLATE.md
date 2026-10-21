## Purpose

Describe the problem and the observable outcome of this change.

## Scope

List the packages, interfaces, and user-visible behavior affected.

## Trust and Compatibility

- [ ] No kernel, schema, protocol, permission, evidence, or completion semantics changed.
- [ ] Any such semantic change is documented by an accepted ADR linked below.
- [ ] No credential, private source, generated artifact, or unrelated formatting change is included.

ADR or compatibility notes:

## Verification

List each command run and its result.

```text
pnpm run verify
pnpm run release:check
```

## Remaining Risk

List unverified platforms, providers, workflows, or known limitations. Write `None` only when the relevant surface was fully verified.

## Contributor Checklist

- [ ] The change is focused and follows existing package boundaries.
- [ ] New behavior has the smallest relevant test coverage.
- [ ] Public documentation and changelog entries are updated where needed.
- [ ] Commits follow Conventional Commits and include a DCO sign-off.

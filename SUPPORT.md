# Support

Keystone is maintained as an open-source release candidate. Support is provided on a best-effort basis and has no service-level agreement.

## Before Opening an Issue

1. Read the [README](./README.en.md) and [documentation index](./docs/README.md).
2. Search [existing issues](https://github.com/abinzhao/keystone-harness/issues).
3. Run `node packages/cli/src/bin.ts doctor` and record the non-sensitive output.
4. Remove credentials, proprietary source, access tokens, and personal data from logs and reproductions.

## Where to Report

| Request | Channel |
|---|---|
| Reproducible defect | Use the bug-report issue form |
| Scoped feature proposal | Use the feature-request issue form |
| Documentation correction | Use the documentation issue form or open a pull request |
| Contribution question | Open an issue with the `question` label |
| Security vulnerability | Follow [SECURITY.md](./SECURITY.md); do not publish exploit details |
| Code of Conduct incident | Follow [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md); do not file a public incident report |

## Useful Diagnostic Information

A useful defect report includes:

- expected and actual behavior;
- minimal reproduction steps;
- Keystone version or commit;
- operating system, Node.js version, and pnpm version;
- run mode and model adapter type;
- relevant logs, task ID, or redacted proof metadata;
- whether the problem reproduces with a deterministic scripted fixture.

Do not attach `~/.keystone/credentials`, real API keys, private repository content, or unredacted proof artifacts.

## Scope

Community support covers the source tree, documented CLI and protocol surfaces, reference extensions, and reproducible development workflows.

The project does not provide:

- commercial or private-deployment support;
- custom migration or data-recovery services;
- a guarantee of model output quality;
- support for unpublished internal APIs;
- signed or notarized desktop binaries in the current release candidate;
- production guarantees for platforms not listed as verified in the README.

See the [roadmap](./ROADMAP.md) for planned work and admission criteria.

# npm release process

The package is published from Git tags. A release tag must match the version in `package.json` exactly: `vX.Y.Z`.

## One-time repository configuration

1. Create an npm automation token with publish permission for `@opentrajectory/digital`.
2. Add it to the GitHub repository as the Actions secret `NPM_TOKEN`.
3. Do not commit the token, an npm auth file, or any other credential.
4. Ensure the package is owned by the npm account or organization that owns the namespace.

## Release checklist

1. Update `package.json` version using Semantic Versioning.
2. Move the completed entries from `[Unreleased]` into a versioned section in `CHANGELOG.md`.
3. Run `npm run ci`; this includes build, unit tests, example execution, `npm pack --dry-run`, installation of the real tarball into a clean consumer project, an ESM import, and a TypeScript declaration check.
4. Merge the release changes into `main`.
5. Create and push the exact matching tag, for example `git tag v0.2.0 && git push origin v0.2.0`.

The `npm-release.yml` workflow validates the tag against `package.json`, runs the full CI suite, and only then publishes the package with npm provenance. A failed validation blocks publication.

## Version policy

- **PATCH** (`0.1.1`): backwards-compatible bug fixes and documentation corrections.
- **MINOR** (`0.2.0`): backwards-compatible public features and additions.
- **MAJOR** (`1.0.0`): incompatible API or behavior changes.
- Before `1.0.0`, breaking changes may use a MINOR increment, but must be called out in the changelog.

The tag is immutable once published. Never reuse a release tag or publish a different artifact under an existing version.

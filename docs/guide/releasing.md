# Releasing npm packages

Kerros releases `@kerros/schema`, `@kerros/viewer`, `@kerros/editor`, and `@kerros/server` together
from one Git tag. Their versions must match the root version and the changelog entry.

## Before creating a release

Run the same checks used by the publishing workflow from a clean checkout:

```sh
npm ci
make check
npm run build
npm run budget
npm run test:packages
npm run release:dry-run
npm run test:production
```

`test:packages` packs all four workspaces, installs those tarballs in a temporary external project,
type-checks without skipping library declarations, creates a production browser bundle, exercises the
Node package, and audits production dependencies. `release:dry-run` displays exactly what npm would
publish and selects `next` for a prerelease or `latest` for a stable version.

Keep the npm trusted publisher settings for every package aligned with this repository:

- workflow: `.github/workflows/npm-publish.yml`
- GitHub environment: `npm`
- repository owner and name: `kherrala/kerros`

The GitHub environment may require approval if that is part of the repository's release policy. No npm
token is stored in the repository; the workflow uses OpenID Connect trusted publishing and requests npm
provenance.

### First publication of a new package name

npm requires the package record to exist before a trusted publisher can be attached. Bootstrap each
new package once with interactive two-factor authentication, then create its trust relationship:

```sh
npm publish --workspace @kerros/schema --access public --tag next
npx npm@12.2.0 trust github @kerros/schema \
  --file npm-publish.yml --repo kherrala/kerros --env npm --allow-publish --yes
```

Repeat those commands for `viewer`, `editor`, and `server`. Subsequent versions are published only by
the GitHub workflow. Complete the first trusted publish within two days of creating the relationship.

## Publish

Commit the version, changelog, lockfile, and package changes. Create a GitHub release whose tag is the
root version prefixed with `v`, such as `v0.1.0-rc.1`. Mark release candidates as prereleases. Publishing
the GitHub release starts the npm workflow, which checks out that exact tag, repeats the source and
tarball checks, and publishes the four packages in dependency order.

npm versions are immutable and publishing several packages is not atomic. If the workflow publishes
only part of a version, fix the problem, increment the prerelease number, and release all four packages
under the new version.

Use a `0.1.0-rc.N` version with the npm `next` tag for public trials. After consumers have validated the
API and installation, release `0.1.0`; the workflow assigns stable versions to `latest`.

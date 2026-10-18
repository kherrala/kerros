# Changelog

All notable changes to the public Kerros packages are recorded here. The four packages share one
version because they are built, tested, and released from the same source revision.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0-rc.2] - 2026-10-19

### Changed

- Published all packages through npm trusted publishing with GitHub Actions provenance after the
  initial package records were bootstrapped with interactive two-factor authentication.

## [0.1.0-rc.1] - 2026-10-18

### Added

- `@kerros/schema`, with the portable project model, validation, geometry mutation, topology, and routing APIs.
- `@kerros/viewer`, with embeddable React 2D, 3D, walk-through, structure, status, and journey views.
- `@kerros/editor`, with authoring tools, browser persistence adapters, and CAD-to-project conversion helpers.
- `@kerros/server`, with Node.js drawing extraction, calibrated analysis, SVG output, and streamed AI imports.
- ESM output, TypeScript declarations, exported stylesheets, package READMEs, and MIT licenses.
- Reproducible tarball consumer tests and automated npm release infrastructure.

[Unreleased]: https://github.com/kherrala/kerros/compare/v0.1.0-rc.2...HEAD
[0.1.0-rc.2]: https://github.com/kherrala/kerros/compare/v0.1.0-rc.1...v0.1.0-rc.2
[0.1.0-rc.1]: https://github.com/kherrala/kerros/releases/tag/v0.1.0-rc.1

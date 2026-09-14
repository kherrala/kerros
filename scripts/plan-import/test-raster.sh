#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
docker build --target analysis-runtime -t kerros-analysis-test .
# Copy only source/test files, never .env or the host's native node_modules. All test
# outputs stay in this disposable container; running development services are untouched.
docker run --rm --network none \
  --mount "type=bind,source=$(pwd),target=/work,readonly" \
  --env KERROS_NATIVE_ANALYSIS_TESTS=1 --env ANTHROPIC_API_KEY= \
  kerros-analysis-test sh -c 'cp -R /work/src /work/scripts /work/server /app/ && cp /work/tsconfig.json /app/ && /app/node_modules/.bin/vitest run --config server/vitest.config.ts scripts/plan-import/raster.test.ts'

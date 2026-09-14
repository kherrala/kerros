FROM node:22-bookworm-slim AS dwg
RUN apt-get update && apt-get install -y --no-install-recommends build-essential curl ca-certificates xz-utils texinfo python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp/libredwg
# Published release checksum: https://github.com/LibreDWG/libredwg/releases/tag/0.13.3
RUN curl -fL --retry 3 https://ftp.gnu.org/gnu/libredwg/libredwg-0.13.3.tar.xz -o source.tar.xz \
    && echo '83f1f6e78a744777a481ff4520e4cef3f8ac4b2c1c25671077ca12fe81e8816e  source.tar.xz' | sha256sum -c - \
    && tar -xf source.tar.xz --strip-components=1 \
    && ./configure --prefix=/opt/libredwg --disable-shared --disable-bindings --disable-docs \
    && make -j2 && make install

FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN chown node:node /app
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node packages ./packages
USER node
RUN npm ci

FROM base AS web
COPY --chown=node:node . .
USER node
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]

FROM base AS analysis-runtime
USER root
# Local raster analysis only; no native image/AI dependencies are sent to the browser.
RUN apt-get update && apt-get install -y --no-install-recommends python3-opencv tesseract-ocr tesseract-ocr-eng tesseract-ocr-fin tesseract-ocr-swe && rm -rf /var/lib/apt/lists/*
USER node

FROM analysis-runtime AS api
USER root
COPY --from=dwg /opt/libredwg /opt/libredwg
ENV PATH="/opt/libredwg/bin:${PATH}" PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install --with-deps chromium && chmod -R a+rX /ms-playwright
RUN mkdir -p /home/node/.cache/kerros-analysis && chown -R node:node /home/node/.cache
COPY --chown=node:node . .
USER node
CMD ["npm", "run", "api"]

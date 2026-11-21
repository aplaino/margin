# The api server: bundled into one file at build time, run on Bun's slim image.
FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile && bun build apps/api/src/index.ts --target=bun --outfile /out/api.js

FROM oven/bun:1.3.14-slim
WORKDIR /app
COPY --from=build /out/api.js .
ENV PORT=8080 HOST=0.0.0.0 MARGIN_ENV=production MARGIN_UPDATES_DIR=/data/updates
EXPOSE 8080
# Starts as root only to give the bun user the release volume, then runs as bun.
CMD ["sh", "-c", "mkdir -p /data/updates && chown -R bun:bun /data && exec setpriv --reuid=bun --regid=bun --init-groups bun api.js"]

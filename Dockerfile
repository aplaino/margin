# The api server: bundled into one file at build time, run on Bun's slim image.
FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile && bun build apps/api/src/index.ts --target=bun --outfile /out/api.js

FROM oven/bun:1.3.14-slim
WORKDIR /app
COPY --from=build /out/api.js .
COPY apps/web ./web
ENV PORT=8080 HOST=0.0.0.0 MARGIN_ENV=production MARGIN_UPDATES_DIR=/data/updates MARGIN_WEB_DIR=/app/web
EXPOSE 8080
# Root only for mkdir/chown (Fly volumes mount owned by root, with no way to set an owner);
# exec setpriv then replaces the shell, so the server and every request run as bun.
CMD ["sh", "-c", "mkdir -p /data/updates && chown -R bun:bun /data && exec setpriv --reuid=bun --regid=bun --init-groups bun api.js"]

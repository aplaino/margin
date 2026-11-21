# The api server: bundled into one file at build time, run on Bun's slim image.
FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile && bun build apps/api/src/index.ts --target=bun --outfile /out/api.js

FROM oven/bun:1.3.14-slim
WORKDIR /app
COPY --from=build /out/api.js .
USER bun
ENV PORT=8080 HOST=0.0.0.0 MARGIN_ENV=production
EXPOSE 8080
CMD ["bun", "api.js"]

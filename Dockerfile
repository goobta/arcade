# The hub and every game in games/, in one image. Games run as child
# processes of the hub, so they share this image's Node.
#
# There is no compile step: Node runs the TypeScript directly, which keeps the
# build to a dependency install (it has to fit on a small droplet).
FROM node:24-alpine AS deps
WORKDIR /app
ENV NODE_ENV=production \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false
COPY package.json package-lock.json ./
COPY packages/hub/package.json packages/hub/
COPY packages/sdk/package.json packages/sdk/
RUN npm ci --omit=dev --ignore-scripts
COPY packages packages
COPY games games
# A game that needs more than the SDK ships its own lockfile and is installed
# in place. Most games need nothing: they resolve @arcade/sdk from /app.
RUN set -e; for dir in games/*/; do \
      if [ -f "${dir}package-lock.json" ]; then \
        (cd "$dir" && npm ci --omit=dev --ignore-scripts); \
      fi; \
    done

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app /app
USER node
EXPOSE 3000
CMD ["node", "--max-old-space-size=64", "packages/hub/src/main.ts"]

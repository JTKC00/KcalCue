# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS codecs
ARG VIPS_VERSION=8.18.6
ARG VIPS_SHA256=3c41e1d5458081bfa4a5bc54e116c46259c75c6760a18027764555632b9dda3e
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl xz-utils build-essential python3 meson ninja-build pkg-config \
    libglib2.0-dev libexpat1-dev libjpeg62-turbo-dev libpng-dev libwebp-dev \
    libheif-dev libde265-dev libx265-dev libexif-dev \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL "https://github.com/libvips/libvips/releases/download/v${VIPS_VERSION}/vips-${VIPS_VERSION}.tar.xz" -o /tmp/vips.tar.xz \
    && echo "${VIPS_SHA256}  /tmp/vips.tar.xz" | sha256sum -c - \
    && tar -xf /tmp/vips.tar.xz -C /tmp \
    && meson setup /tmp/vips-build "/tmp/vips-${VIPS_VERSION}" --prefix=/usr/local --libdir=lib \
       --buildtype=release -Dintrospection=disabled -Dmodules=disabled -Dexamples=false -Dheif=enabled \
    && meson compile -C /tmp/vips-build -j 2 \
    && meson install -C /tmp/vips-build \
    && ldconfig \
    && rm -rf /tmp/vips*

FROM codecs AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund \
    && SHARP_FORCE_GLOBAL_LIBVIPS=1 npm explore sharp -- npm run build
# Copy only build inputs. Docker ignore patterns are a second guard against
# accidentally uploading local meal photos to a remote builder.
COPY next.config.ts tsconfig.json next-env.d.ts ./
COPY src ./src
COPY public ./public
COPY scripts/check-codecs.mjs scripts/smoke-container.mjs ./scripts/
# These four values are public Firebase Web configuration, never Admin/API secrets.
ARG NEXT_PUBLIC_FIREBASE_API_KEY
ARG NEXT_PUBLIC_FIREBASE_PROJECT_ID
ARG NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
ARG NEXT_PUBLIC_FIREBASE_APP_ID
ENV NEXT_PUBLIC_FIREBASE_API_KEY=$NEXT_PUBLIC_FIREBASE_API_KEY \
    NEXT_PUBLIC_FIREBASE_PROJECT_ID=$NEXT_PUBLIC_FIREBASE_PROJECT_ID \
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=$NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN \
    NEXT_PUBLIC_FIREBASE_APP_ID=$NEXT_PUBLIC_FIREBASE_APP_ID \
    NEXT_TELEMETRY_DISABLED=1 KCALCUE_STANDALONE=1
RUN node scripts/check-codecs.mjs && npm run build

FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libglib2.0-0 libexpat1 libjpeg62-turbo libpng16-16 libwebp7 libwebpdemux2 libwebpmux3 \
    libheif1 libde265-0 libx265-199 libexif12 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=codecs /usr/local/lib/ /usr/local/lib/
RUN ldconfig
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=8080
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
# Keep the tested native binding even if Next's tracer chooses only a prebuilt optional package.
COPY --from=build --chown=node:node /app/node_modules/sharp ./node_modules/sharp
COPY --from=build --chown=node:node /app/scripts/check-codecs.mjs ./scripts/check-codecs.mjs
COPY --from=build --chown=node:node /app/scripts/smoke-container.mjs ./scripts/smoke-container.mjs
USER node
RUN node scripts/check-codecs.mjs
EXPOSE 8080
CMD ["node", "server.js"]

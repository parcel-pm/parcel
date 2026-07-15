# syntax=docker/dockerfile:1.7
# Docker image for testing the Parcel extension.
#
# Provides a reproducible environment containing all of Parcel's build and test
# toolchain: bash, make, node, npm, jq, gpg, rsync, zip, and moreutils (for
# `sponge`).
#
# BuildKit cache mounts are used for apt and npm. Build with DOCKER_BUILDKIT=1.

FROM ubuntu:latest

LABEL org.opencontainers.image.title="parcel-test" \
      org.opencontainers.image.description="Test environment for the Parcel browser extension" \
      org.opencontainers.image.source="https://github.com/parcel-pm/parcel"

# Avoid interactive prompts during apt operations
ENV DEBIAN_FRONTEND=noninteractive

# Install runtime + build dependencies documented in README.md / CONTRIBUTING.md
# and required by the Makefile (rsync, jq, zip, sponge, gpg, node, npm, git for
# the release target & submodules).
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        make \
        rsync \
        jq \
        gnupg \
        gpg \
        zip \
        gzip \
        moreutils \
        git \
        curl \
        xz-utils \
    && apt-get clean

# Install Node.js from NodeSource so we have a recent, supported version
# (the suite uses `node --test`).
ARG NODE_MAJOR=22
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean

WORKDIR /parcel
# `make` reads $PWD from the environment to locate `node_modules/.bin/prettier`.
# Docker's WORKDIR chdir doesn't set PWD itself, so export it explicitly.
ENV PWD=/parcel

# Install JS dev dependencies (prettier, jsdom) so the toolchain is ready
# before the repo is mounted in.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund --ignore-scripts

# The repository is NOT copied into the image. Instead, bind-mount the repo
# directory into /parcel at run time so the container always sees the current
# working-tree state, e.g.
#   docker run --rm -v "$PWD":/parcel parcel-test test
#   docker run --rm -v "$PWD":/parcel parcel-test chrome
ENTRYPOINT ["make"]
CMD ["all"]

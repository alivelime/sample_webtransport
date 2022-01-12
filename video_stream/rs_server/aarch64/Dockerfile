# This image is used for running CI tests.
# The image is not built unless the `docker` branch is updated.
# Push to `docker` to trigger a build:
#  $ git push origin main:docker

FROM ubuntu:20.04
LABEL maintainer="Martin Thomson <mt@lowentropy.net>"

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    coreutils \
    curl \
    git \
    make \
    mercurial \
    ssh \
    build-essential \
    clang \
    llvm \
    libclang-dev \
    lld \
    gyp \
    ninja-build \
    pkg-config \
    python-is-python3 \
    python3 \
    python3-pip \
    sudo \
    zlib1g-dev \
 && apt-get autoremove -y && apt-get clean -y \
 && rm -rf /var/lib/apt/lists/*

ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH \
    RUST_VERSION=1.57.0

RUN set -eux; \
    curl -sSLf "https://static.rust-lang.org/rustup/dist/aarch64-unknown-linux-gnu/rustup-init" -o rustup-init; \
    chmod +x rustup-init; \
    ./rustup-init -y -q --no-modify-path --profile minimal --component rustfmt --component clippy --default-toolchain "$RUST_VERSION"; \
    rm -f rustup-init; \
    chmod -R a+w "$RUSTUP_HOME" "$CARGO_HOME"

ENV USER neqo
ENV LOGNAME $USER
ENV HOSTNAME $USER
ENV HOME /home/$USER
ENV SHELL /bin/bash

RUN useradd -d "$HOME" -s "$SHELL" -m "$USER"
RUN echo "$USER ALL=(ALL) NOPASSWD: ALL" >> /etc/sudoers
WORKDIR $HOME
USER $USER

ENV NSS_DIR=$HOME/nss \
    NSPR_DIR=$HOME/nspr \
    LD_LIBRARY_PATH=$HOME/dist/Debug/lib \
    RUSTFLAGS="-C link-arg=-fuse-ld=lld"

EXPOSE 4433

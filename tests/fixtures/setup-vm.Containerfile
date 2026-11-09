FROM debian:12-slim
RUN apt-get update && apt-get install -y --no-install-recommends qemu-system-arm qemu-utils qemu-efi-aarch64 openssh-client curl ca-certificates genisoimage python3 && rm -rf /var/lib/apt/lists/*

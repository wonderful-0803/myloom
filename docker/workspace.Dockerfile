# Team workspace image: Node for DSH, plus git (DSH's deployment check) and python3 (office skills).
# DSH, the Loom code and dependencies are mounted read-only at run time; nothing secret is baked in.
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

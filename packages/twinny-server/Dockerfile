# twinny-server as a container. One file of JavaScript on a Node runtime;
# no build step here, so `npm run build` at the repository root first.
#
#   docker build -t twinny-server packages/twinny-server
#   docker run --rm -v twinny-data:/data twinny-server init /data/twinny.gateway.json --host 0.0.0.0 --ollama host.docker.internal
#   docker run --rm -v twinny-data:/data twinny-server keys create you --admin --config /data/twinny.gateway.json
#   docker run -d -p 127.0.0.1:8765:8765 -v twinny-data:/data twinny-server
#
# Node 22 so recordings default to the built-in sqlite store.
# Everything the gateway writes (keys, usage, licence, recordings) lives under /data,
# which is HOME inside the container, so the defaults in the docs apply
# unchanged. The listener must bind 0.0.0.0 inside the container; the
# port is published to loopback on the host and TLS goes in front.
FROM node:22-alpine

ENV NODE_ENV=production \
    HOME=/data

RUN addgroup -S twinny && adduser -S -G twinny -h /data twinny \
    && mkdir -p /data && chown twinny:twinny /data

WORKDIR /app
COPY cli.js package.json README.md ./

VOLUME ["/data"]
EXPOSE 8765
USER twinny

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD wget -qO- http://127.0.0.1:8765/healthz >/dev/null || exit 1

ENTRYPOINT ["node", "/app/cli.js"]
CMD ["serve", "--config", "/data/twinny.gateway.json"]

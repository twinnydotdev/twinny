# twinny-server on Kubernetes

```sh
helm install twinny ./deploy/helm/twinny-server \
  --set config.providers.local.apiHostname=ollama.models.svc.cluster.local \
  --set ingress.enabled=true --set ingress.host=twinny.example.com --set ingress.tls.enabled=true
```

The chart runs one pod with one volume for keys, usage, licence, audit,
plugins and recordings; `replicaCount` stays at 1. The configuration in
`values.yaml` is copied onto the volume at start, so the admin page can
edit it; a `helm upgrade` puts the chart's copy back. Backend API keys go
in as environment variables named by `apiKeyEnv` (see `env`/`envFrom`).
With the Prometheus operator, `serviceMonitor.enabled=true` scrapes
`/metrics` with a read-only admin key kept in a secret under `token`.

Image: `ghcr.io/twinnydotdev/twinny-server`, built by
`.github/workflows/docker.yml` on every `v*` tag.

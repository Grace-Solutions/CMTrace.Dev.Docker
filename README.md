# CMTrace.Dev.Docker

A self-hosted, offline-capable container image that serves [CMTrace.dev](https://cmtrace.dev/) — a free, zero-install browser-based log viewer for ConfigMgr, SCCM and Intune. Open massive client logs, color-code severity and chase down error codes — all 100% on your machine.

The container ships the static PWA assets behind a hardened, unprivileged nginx and runs entirely offline once the image is pulled.

## Quick start (Docker Compose)

```bash
cp .env.example .env
# (optional) edit .env to change CMTRACE_PORT / CMTRACE_VERSION
docker compose up -d
```

Then open <http://localhost:19847/>.

To build the image locally instead of pulling from GHCR:

```bash
docker compose build
docker compose up -d
```

### One-shot `docker run`

```bash
docker run -d --name CMTRACE-APP-00001 -p 19847:19847 \
  ghcr.io/grace-solutions/cmtrace.dev.docker:latest
```

## Configuration

All knobs live in `.env` (see `.env.example`):

| Variable                          | Default                                       | Purpose                                                  |
| --------------------------------- | --------------------------------------------- | -------------------------------------------------------- |
| `STACK_NAME`                      | `stk-cmtrace-00001`                           | Compose project / network prefix                         |
| `CMTRACE_IMAGE`                   | `ghcr.io/grace-solutions/cmtrace.dev.docker`  | Image repository                                         |
| `CMTRACE_VERSION`                 | `latest`                                      | Image tag (e.g. `v1.0.0`, `sha-abc1234`)                 |
| `BIND_EXTERNAL_ADDRESS`           | `0.0.0.0`                                     | Host interface to bind the published port to             |
| `CMTRACE_PORT`                    | `19847`                                       | Host port (container always listens on `19847`)          |
| `CMTRACE_TRUSTED_PROXIES`         | RFC1918 + CGNAT + loopback + IPv6 ULA/LL      | CIDRs allowed to set `X-Forwarded-For`. Use `*` to trust all. |
| `CMTRACE_ENABLEAUTOMATICUPDATES`  | `false`                                       | Watchtower auto-update label toggle                      |

The container is always reachable inside the stack as service `App` on port `19847`.

### Reverse-proxy / real-client-IP

When the container sits behind a reverse proxy (Nginx Proxy Manager, Traefik, Caddy, SWAG, an ingress controller, etc.), set `CMTRACE_TRUSTED_PROXIES` to the proxy's CIDR(s) so the container logs the real client IP via `X-Forwarded-For`. The default trusts private/loopback ranges only, which covers same-host and same-LAN proxies. To trust all sources (closed network only), use `CMTRACE_TRUSTED_PROXIES=*`.

### Zero-touch image build

The Dockerfile is two-stage: if `src/` in the build context is empty (or missing core files), stage 1 mirrors the published static site from `cmtrace.dev` at build time. If `src/` is already populated, that local copy is used as-is. Either way the runtime image is fully self-contained — no network access required at runtime.

## Image tags

Published to `ghcr.io/grace-solutions/cmtrace.dev.docker`:

- `latest` — current `main`
- `main` — current `main` (alias)
- `sha-<short>` — every merged commit on `main`
- `vX.Y.Z`, `vX.Y`, `vX` — semver tags

Multi-arch: `linux/amd64`, `linux/arm64`.

## Development

The repository targets the `development` branch for changes. CI builds on every PR against `main` (validation only, no push) and publishes on merge into `main` and on `v*.*.*` tags.

Layout:

```
src/                       # Static PWA assets mirrored from cmtrace.dev
docker/nginx/              # nginx config + extra MIME types
Dockerfile                 # Image build
docker-compose.yml         # Local run
.github/workflows/         # CI/CD
```

## Credits

CMTrace.dev is built by [Florian Salzmann](https://scloud.work/about-florian/) and [Jannik Reinhard](https://jannikreinhard.com/about/). This repository only packages the published static site into a container for offline / self-hosted use; all credit for the application itself goes to the original authors.

Not affiliated with or endorsed by Microsoft. "CMTrace" is a Microsoft tool and trademark.

## License

GPL-3.0-or-later — see [LICENSE](./LICENSE).

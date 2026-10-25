# Secrets

This public repo contains **no secrets**. Templates (`*.tmpl`) hold `${NAME}` placeholders
that `setup.mjs render` fills from a local `secrets.env`:

| OS | Default location |
|---|---|
| macOS / Linux | `~/.config/pi-setup/secrets.env` (mode 600) |
| Windows | `%USERPROFILE%\.config\pi-setup\secrets.env` |

Override with `PI_SETUP_SECRETS=/path/to/secrets.env`. Values from the process environment
are used when a name is missing in the file. Format: `NAME=value`, one per line, `#` comments.

## Getting them on a new machine

**A. Private GitHub repo (default).** The owner keeps `secrets.env` in the private repo
`priaculun/pi-setup-secrets` (override: `PI_SETUP_SECRETS_REPO=owner/repo`).

```sh
gh auth login                              # account with access to the private repo
node scripts/setup.mjs secrets pull        # writes secrets.env (600)
node scripts/setup.mjs secrets check       # lists names, never values
```

`apply` runs `secrets pull` automatically when no `secrets.env` exists and `gh` is logged in.

**B. Manual.** Copy `secrets.env.example` to the location above and fill each value from its
source (table below), or copy the file from another machine over a secure channel
(`scp`, password manager attachment). Never paste it into chat, issues, or an agent prompt.

## Variables

| Name | Used in | Where to get it |
|---|---|---|
| `PI_KEY_ONTOKEN` | models.json → provider `ontoken` | ontoken.id dashboard → API keys |
| `PI_KEY_BACK_LIM` | provider `back-lim` | limitrouter dashboard |
| `PI_KEY_CFROUTER` | provider `cfrouter` | cfrouter.my.id dashboard |
| `PI_KEY_GATEAI` | provider `gateai` | gateai.id dashboard |
| `PI_KEY_ALFAROUTER` | provider `alfarouter` | self-hosted router (Tailscale) config |
| `PI_HOST_ALFAROUTER` | provider `alfarouter` base URL | Tailscale IP of the router host (`tailscale status`) |
| `PI_KEY_GRIDHUB_UJI` | provider `gridhub-uji` | griphubrouter.web.id dashboard |
| `PI_KEY_OCTALABS` | provider `octalabs` | router.octalabs.id dashboard |
| `PI_KEY_A6API` | provider `a6api` | a6api.com dashboard |
| `MCP_ONTOKEN_MEDIA_TOKEN` | mcp.json → `ontoken-media` | ontoken.id dashboard (MCP token, not the API key) |
| `MCP_HOST_HINDSIGHT_OMP` | mcp.json → `hindsight-omp` URL | Tailscale IP of the Hindsight server |
| `MCP_HINDSIGHT_OMP_TOKEN` | mcp.json → `hindsight-omp` | Hindsight server config (`hs-local-…` token) |
| `REMOTE_PI_RELAY_HOST` | `~/.pi/remote/config.json` | Tailscale IP of the remote-pi relay |
| `TYPESAFE_API_KEY` | `~/.pi/agent/secrets/typesafe_api_key` (ontoken-auto JEV) | typesafe / JEV account |

Hosts are secrets-adjacent (private Tailscale IPs), so they are kept out of the public repo too.

## Maintaining

| Change | Do |
|---|---|
| New provider / MCP server added live | `node scripts/setup.mjs capture` → new names appear in secrets.env and as `${…}` in templates; then `secrets push`; add a row above + to `secrets.env.example` |
| Key rotated | edit `secrets.env` (or the live file + `capture`), `render`, `secrets push` |
| Leak suspected | rotate at the provider first, then update `secrets.env` + `secrets push` |

`secrets push` refuses to upload unless the target repo is private.
`scan` (also run by `capture` and CI) fails on literal keys, bearer tokens, Tailscale IPs,
absolute home paths, and on any value present in your local `secrets.env`.

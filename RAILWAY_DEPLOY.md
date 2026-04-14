# Railway Deployment Guide

This guide walks you through deploying Randal to [Railway](https://railway.app/) — a simple, scalable cloud platform.

## Quick Start

### 1. Fork/Clone This Repository

```bash
git clone https://github.com/drewbietron/randal.git
cd randal
```

### 2. Create a Railway Project

```bash
# Install Railway CLI if you haven't already
npm install -g @railway/cli

# Login to Railway
railway login

# Initialize a new project
railway init
```

### 3. Configure Environment Variables

Set these required variables in the Railway Dashboard:

| Variable | Description | Get it from |
|----------|-------------|-------------|
| `ANTHROPIC_API_KEY` | Claude API access | [console.anthropic.com](https://console.anthropic.com) |
| `RANDAL_API_TOKEN` | API authentication | Generate a secure random string |
| `MEILI_MASTER_KEY` | Meilisearch auth | Generate a secure random string |

Optional variables for extended functionality:

| Variable | Description |
|----------|-------------|
| `OPENROUTER_API_KEY` | Alternative LLM provider |
| `TAVILY_API_KEY` | Web search capability |
| `GH_TOKEN` | GitHub CLI operations |
| `DISCORD_BOT_TOKEN` | Discord integration |

### 4. Deploy

```bash
railway up
```

Your Randal instance will be available at the URL Railway provides.

## Configuration

### railway.toml

The `railway.toml` file defines how Railway builds and deploys your app:

- **Builder**: Uses Dockerfile for custom build
- **Health Check**: Monitors `/health` endpoint
- **Resources**: Configured for 2GB RAM minimum
- **Persistent Disk**: Optional (see below)

### randal.config.railway.yaml

The headless configuration file optimized for cloud deployment:

- **Gateway**: HTTP API on port 7600
- **Memory**: Embedded Meilisearch
- **Heartbeat**: Checks for pending tasks every 30 minutes
- **Sandbox**: Environment variable scrubbing enabled

## API Usage

Once deployed, interact with Randal via the HTTP API:

```bash
# Check health
curl https://your-app.railway.app/health

# Create a job
curl -X POST https://your-app.railway.app/api/jobs \
  -H "Authorization: Bearer $RANDAL_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "agent": "opencode",
    "prompt": "Create a Python script that fetches weather data"
  }'
```

## Persistent Data

By default, Railway uses ephemeral storage — data is lost on redeploy. To persist Meilisearch data and workspace files:

### Option 1: Enable Persistent Disk (Recommended)

Uncomment in `railway.toml`:

```toml
[[deploy.persistentDisk]]
mountPath = "/app/meeli-data"
size = 5  # GB
name = "meili-data"
```

### Option 2: External Meilisearch

Update `randal.config.railway.yaml` to use an external Meilisearch instance:

```yaml
memory:
  store: meilisearch
  url: https://your-meili-instance.railway.app
  apiKey: "${MEILI_MASTER_KEY}"
```

## Examples

See the `examples/cloud-railway/` directory for:

- `Dockerfile` — Extended image with custom config
- `randal.config.railway.yaml` — Example configuration
- `.env.example` — Environment variable template

## Troubleshooting

### Build Failures

Check Railway build logs. Common issues:
- Missing required env vars
- Network timeouts (retry the deployment)

### Container Crashes

- Ensure `MEILI_MASTER_KEY` is set
- Check memory allocation (needs 2GB+)
- Review application logs in Railway dashboard

### API Authentication Errors

Verify `RANDAL_API_TOKEN` is set and included in request headers:

```bash
curl -H "Authorization: Bearer $RANDAL_API_TOKEN" ...
```

## Security Notes

- Never commit `.env` files or API keys
- Use Railway's secret management for all credentials
- Enable persistent disk if storing sensitive data
- Rotate `RANDAL_API_TOKEN` and `MEILI_MASTER_KEY` regularly

## Updating

To update to the latest version:

```bash
git pull origin main
railway up
```

## Support

- **Issues**: [GitHub Issues](https://github.com/drewbietron/randal/issues)
- **Discussions**: [GitHub Discussions](https://github.com/drewbietron/randal/discussions)
- **Documentation**: See `README.md` and `AGENTS.md`

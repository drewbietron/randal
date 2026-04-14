# 🚂 Railway Deployment Guide

Deploy Randal to Railway in minutes with automatic HTTPS, health checks, and zero-config scaling.

## Quick Deploy (3 steps)

### 1. Fork/Clone and Configure

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/randal.git
cd randal

# The railway.toml and randal.config.railway.yaml are already configured
```

### 2. Set Environment Variables

In Railway Dashboard → Your Project → Variables, add:

**Required:**
- `ANTHROPIC_API_KEY` - Your Anthropic API key (starts with `sk-ant-`)
- `RANDAL_API_TOKEN` - Generate a secure random token (e.g., `openssl rand -hex 32`)
- `MEILI_MASTER_KEY` - Generate another secure key for Meilisearch

**Optional:**
- `OPENROUTER_API_KEY` - For OpenRouter model access
- `TAVILY_API_KEY` - For web search capabilities  
- `GH_TOKEN` - For GitHub CLI operations (PR creation, etc.)
- `DISCORD_BOT_TOKEN` - For Discord integration

### 3. Deploy

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Link to your project
railway link

# Deploy
railway up
```

## Accessing Your Deployed Randal

Once deployed, Railway provides a public URL:

```
🎉 Randal is running!
   Dashboard: https://your-project.railway.app
   Gateway: https://your-project.railway.app
   Health: https://your-project.railway.app/health
   
   Authentication: Bearer Token (set in RANDAL_API_TOKEN)
```

### Using the Dashboard

Open `https://your-project.railway.app` in your browser. You'll see the real-time dashboard with:
- Active jobs
- Memory search
- Cost tracking
- System health

### Using the API

```bash
# Check health
curl https://your-project.railway.app/health

# Submit a job
curl -X POST https://your-project.railway.app/api/v1/run \
  -H "Authorization: Bearer YOUR_RANDAL_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "refactor the auth module"}'

# List jobs
curl https://your-project.railway.app/api/v1/jobs \
  -H "Authorization: Bearer YOUR_RANDAL_API_TOKEN"

# Check job status
curl https://your-project.railway.app/api/v1/jobs/JOB_ID \
  -H "Authorization: Bearer YOUR_RANDAL_API_TOKEN"
```

### Using the CLI Locally

Point your local CLI at the Railway deployment:

```bash
# Set the remote gateway
export RANDAL_GATEWAY_URL=https://your-project.railway.app
export RANDAL_API_TOKEN=your-token-here

# Now use randal commands against your cloud instance
randal jobs
randal status JOB_ID
```

## Architecture

```
┌─────────────────────────────────────────┐
│           Railway.app                   │
│  ┌─────────────────────────────────┐   │
│  │      Randal Container           │   │
│  │  ┌─────────────────────────┐   │   │
│  │  │    randal serve         │   │   │
│  │  │    Port: 7600           │───┼───┼──→ https://...railway.app
│  │  └─────────────────────────┘   │   │
│  │  ┌─────────────────────────┐   │   │
│  │  │  Embedded Meilisearch   │   │   │
│  │  │  Port: 7700 (internal)  │   │   │
│  │  └─────────────────────────┘   │   │
│  └─────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

## Troubleshooting

### Build Fails
- Check that `railway.toml` exists at project root
- Verify `Dockerfile` is at project root
- Ensure `randal.config.railway.yaml` exists

### Health Check Fails
- Check Railway logs: `railway logs`
- Verify `RANDAL_API_TOKEN` is set
- Ensure `ANTHROPIC_API_KEY` is valid

### Can't Access Dashboard
- Check that port 7600 is exposed in Dockerfile
- Verify health endpoint responds: `curl https://.../health`
- Check Railway domain settings

### Memory Not Persisting
- Meilisearch data is stored in container at `/app/meeli-data`
- Railway volumes are ephemeral unless you configure persistent storage
- For production, consider external Meilisearch: set `RANDAL_SKIP_MEILISEARCH=true` and point to external instance

## Updates

To update to the latest Randal version:

```bash
# Pull latest
git pull origin main

# Redeploy
railway up
```

The new image will be built from the updated `ghcr.io/drewbietron/randal:latest`.

## Advanced Configuration

### Custom Domain

In Railway Dashboard → Settings → Domains:
1. Add your custom domain
2. Update DNS records as instructed
3. Randal will be available at your domain

### Scaling

Railway automatically scales based on load. For dedicated resources:
- Railway Dashboard → Your Service → Settings
- Configure CPU/RAM limits

### External Meilisearch

For persistent memory across deploys:

1. Set `RANDAL_SKIP_MEILISEARCH=true` in Railway variables
2. Deploy Meilisearch separately (Meilisearch Cloud or self-hosted)
3. Update config:
   ```yaml
   memory:
     url: https://your-meilisearch-instance.com
     apiKey: "${MEILI_MASTER_KEY}"
   ```

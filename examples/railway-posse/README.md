# Railway Multi-Project Posse Deployment

This directory contains everything you need to deploy a complete Randal posse to Railway with Meilisearch and multiple specialized agents.

## Overview

A Railway posse consists of:
- **1 Meilisearch instance** (shared memory store for all agents)
- **N specialized Randal agents** (each with its own expertise and resources)

All agents discover each other through Meilisearch and can delegate tasks to specialists.

## Quick Start

### Prerequisites

1. **Railway Account**: Sign up at [railway.app](https://railway.app)
2. **Railway CLI**: Install with `npm install -g @railway/cli`
3. **Dependencies**: Install `yq` and `jq` for YAML/JSON parsing
   ```bash
   brew install yq jq  # macOS
   ```
4. **OpenRouter API Key**: Set your OpenRouter API key in the environment
   ```bash
   export OPENROUTER_API_KEY="your-key-here"
   ```

### Deploy a Posse

1. **Choose a configuration** (or create your own):
   ```bash
   # Full 10-agent company posse
   ./scripts/deploy-railway-posse.sh examples/railway-posse/full-company.yaml
   ```

2. **Wait for deployment** (~5-10 minutes):
   - Meilisearch will deploy first
   - Each agent will deploy sequentially
   - Health checks will verify all services are running

3. **Verify deployment**:
   ```bash
   railway status
   railway logs --service meilisearch
   railway logs --service product-engineering
   ```

### Manage Posses

```bash
# List all deployed posses
./scripts/list-railway-posses.sh

# Delete a posse
./scripts/delete-railway-posse.sh full-company
```

## Directory Structure

```
railway-posse/
├── archetypes/
│   ├── expertise/              # Detailed expertise profiles
│   │   ├── product-engineering.md
│   │   ├── platform-infrastructure.md
│   │   ├── security-compliance.md
│   │   ├── data-intelligence.md
│   │   ├── design-experience.md
│   │   ├── content-communications.md
│   │   ├── revenue-growth.md
│   │   ├── customer-operations.md
│   │   ├── strategy-finance.md
│   │   └── legal-governance.md
│   └── base.config.yaml        # Base configuration all agents inherit
├── full-company.yaml           # 10-agent full company posse
└── README.md                   # This file
```

## Posse Configurations

### Full Company Posse (`full-company.yaml`)

A complete 10-agent posse covering all business functions:

1. **Product Engineering** - Full-stack development, React, TypeScript, Node.js, PostgreSQL
2. **Platform Infrastructure** - DevOps, Kubernetes, Terraform, AWS/GCP, CI/CD
3. **Security & Compliance** - AppSec, OWASP, SOC2, GDPR, penetration testing
4. **Data & Intelligence** - Data pipelines, analytics, BigQuery, Snowflake, ML
5. **Design & Experience** - UX/UI, Figma, design systems, accessibility
6. **Content & Communications** - Technical writing, docs, marketing copy
7. **Revenue & Growth** - Sales, GTM, pricing, partnerships
8. **Customer Operations** - Support, success, onboarding, retention
9. **Strategy & Finance** - Product management, OKRs, financial modeling
10. **Legal & Governance** - Contracts, compliance, IP, privacy

**Resources**:
- Meilisearch: 4GB RAM, 2 vCPU, 20GB storage
- Total agents: 10 (ranging from 0.5-1 vCPU, 1-2GB RAM each)
- **Estimated cost**: ~$225/month on Railway

## Configuration Format

### Posse Configuration (`*.yaml`)

```yaml
# Posse metadata
posse:
  name: "my-posse"
  description: "Description of the posse"
  version: "1.0.0"

# Shared resources (Meilisearch)
shared:
  meilisearch:
    plan: "pro"
    memory: "4Gi"
    cpu: "2"
    storage: "20Gi"

# Agent definitions
agents:
  - name: "agent-name"
    role: "agent-role"
    expertise:
      - "skill1"
      - "skill2"
    specialization: "What this agent specializes in"
    expertise_file: "archetypes/expertise/agent-name.md"
    resources:
      memory: "2Gi"
      cpu: "1"
    replicas: 1

# Routing rules (optional)
routing:
  rules:
    - keywords: ["react", "frontend"]
      route_to: "product-engineering"
```

### Expertise Profile (`expertise/*.md`)

Each agent has a detailed expertise profile (1500+ words) covering:
- Core technical skills
- Development practices
- Common problem domains
- Debugging & troubleshooting
- Communication & collaboration
- Continuous learning

## Deployment Scripts

### `deploy-railway-posse.sh`

Deploys a complete posse to Railway.

```bash
./scripts/deploy-railway-posse.sh [OPTIONS]

Options:
  --config FILE       Path to posse configuration YAML
  --name NAME         Posse name (default: from config)
  --dry-run          Print commands without executing
  --help             Show help message
```

**What it does**:
1. Validates dependencies (Railway CLI, yq, jq)
2. Parses posse configuration
3. Creates Railway project
4. Generates Meilisearch master key
5. Deploys Meilisearch service
6. Deploys all agent services
7. Creates deployment summary JSON

### `list-railway-posses.sh`

Lists all deployed posses.

```bash
./scripts/list-railway-posses.sh
```

Shows local deployment summaries and instructions for viewing in Railway dashboard.

### `delete-railway-posse.sh`

Deletes a posse from Railway.

```bash
./scripts/delete-railway-posse.sh POSSE_NAME [OPTIONS]

Options:
  --dry-run         Print what would be deleted
  --force           Skip confirmation prompts
  --help            Show help message
```

## Creating Custom Posses

### 1. Define Your Agents

Create a new YAML configuration:

```yaml
posse:
  name: "my-custom-posse"
  description: "A custom posse for specific needs"
  version: "1.0.0"

shared:
  meilisearch:
    memory: "2Gi"
    cpu: "1"
    storage: "10Gi"

agents:
  - name: "specialist-1"
    role: "specialist-1"
    expertise: ["skill1", "skill2"]
    specialization: "What they do"
    expertise_file: "archetypes/expertise/specialist-1.md"
    resources:
      memory: "1Gi"
      cpu: "0.5"
    replicas: 1
```

### 2. Create Expertise Profiles

Create detailed expertise profiles in `archetypes/expertise/`:

```markdown
# Specialist Name Expertise Profile

## Overview
What this specialist does...

## Core Skills
- Skill 1
- Skill 2

## Common Problem Domains
What problems they solve...

## Key Strengths Summary
What they excel at...
```

### 3. Deploy Your Posse

```bash
./scripts/deploy-railway-posse.sh examples/railway-posse/my-custom-posse.yaml
```

## Cost Optimization

### Tips for Reducing Costs

1. **Scale down when not in use**:
   ```bash
   railway down --service agent-name
   ```

2. **Use smaller agents for less demanding tasks**:
   ```yaml
   resources:
     memory: "512Mi"
     cpu: "0.25"
   ```

3. **Deploy only needed agents**:
   - Start with a minimal posse (3-5 agents)
   - Add specialists as needed

4. **Use Railway's free tier**:
   - $5/month free credit
   - Good for testing and small posses

### Cost Breakdown (Full Company Posse)

| Component | Resources | Monthly Cost (est.) |
|-----------|-----------|---------------------|
| Meilisearch | 4GB RAM, 2 vCPU | ~$50 |
| 10 Agents | 11GB RAM total, 6.5 vCPU total | ~$175 |
| **Total** | | **~$225** |

## Troubleshooting

### Deployment Issues

**Problem**: Railway CLI not authenticated
```bash
railway login
```

**Problem**: Missing dependencies
```bash
brew install yq jq
npm install -g @railway/cli
```

**Problem**: Deployment fails
```bash
# Check logs
railway logs --service <service-name>

# Verify environment variables
railway variables
```

### Agent Communication Issues

**Problem**: Agents can't find each other
- Verify Meilisearch is healthy: `railway logs --service meilisearch`
- Check agent logs for connection errors
- Verify `MEILISEARCH_HOST` environment variable is set correctly

**Problem**: Agent not responding
- Check agent logs: `railway logs --service <agent-name>`
- Verify OpenRouter API key is set
- Check resource allocation (may need more memory/CPU)

## Advanced Usage

### Custom Routing Rules

Add routing rules to automatically direct queries to appropriate specialists:

```yaml
routing:
  rules:
    - keywords: ["database", "sql", "query"]
      route_to: "data-intelligence"
    - keywords: ["security", "vulnerability"]
      route_to: "security-compliance"
```

### Multi-Region Deployment

Deploy agents in different Railway regions for lower latency:

```yaml
agents:
  - name: "agent-us"
    region: "us-west1"
  - name: "agent-eu"
    region: "europe-west1"
```

### Health Checks

All agents expose a health check endpoint:

```bash
curl https://<agent-url>/health
```

Returns:
```json
{
  "status": "healthy",
  "agent": "product-engineering",
  "meilisearch": "connected",
  "uptime": 3600
}
```

## Next Steps

1. **Deploy your first posse**: Start with `full-company.yaml` or create a custom configuration
2. **Test agent communication**: Send tasks and verify delegation works
3. **Monitor performance**: Use Railway dashboard and agent logs
4. **Scale as needed**: Add/remove agents, adjust resources
5. **Optimize costs**: Scale down unused agents, right-size resources

## Support

- **Railway Documentation**: https://docs.railway.app
- **Randal Repository**: https://github.com/your-org/randal
- **Meilisearch Docs**: https://docs.meilisearch.com

## License

[Your License Here]

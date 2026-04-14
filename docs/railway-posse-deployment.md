# Railway Multi-Project Posse Deployment Guide

This comprehensive guide covers deploying, managing, and operating Randal posses on Railway.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Prerequisites](#prerequisites)
3. [Deployment](#deployment)
4. [Configuration](#configuration)
5. [Operations](#operations)
6. [Monitoring](#monitoring)
7. [Troubleshooting](#troubleshooting)
8. [Cost Management](#cost-management)
9. [Best Practices](#best-practices)

## Architecture Overview

### What is a Railway Posse?

A Railway posse is a distributed system of specialized Randal AI agents that work together to handle diverse tasks. Each agent has deep expertise in a specific domain and can delegate tasks to other specialists.

### Components

```
┌─────────────────────────────────────────────────┐
│           Railway Project                       │
│                                                 │
│  ┌──────────────┐                              │
│  │ Meilisearch  │ ← Shared memory & discovery  │
│  └──────┬───────┘                              │
│         │                                       │
│         │ ┌─────────────────────────────────┐ │
│         ├─┤ Product Engineering Agent       │ │
│         │ └─────────────────────────────────┘ │
│         │                                       │
│         │ ┌─────────────────────────────────┐ │
│         ├─┤ Platform Infrastructure Agent   │ │
│         │ └─────────────────────────────────┘ │
│         │                                       │
│         │ ┌─────────────────────────────────┐ │
│         ├─┤ Security & Compliance Agent     │ │
│         │ └─────────────────────────────────┘ │
│         │                                       │
│         │ ┌─────────────────────────────────┐ │
│         └─┤ ... (more agents)               │ │
│           └─────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

### How It Works

1. **Shared Memory**: All agents connect to a central Meilisearch instance
2. **Discovery**: Agents register themselves and discover peers via Meilisearch
3. **Delegation**: Agents can delegate tasks to specialists based on expertise
4. **Learning**: Agents store learnings, patterns, and context in shared memory
5. **Collaboration**: Agents work together on complex multi-domain tasks

## Prerequisites

### Required Tools

```bash
# Railway CLI
npm install -g @railway/cli

# YAML processor
brew install yq  # macOS
# or: apt-get install yq  # Linux

# JSON processor
brew install jq  # macOS
# or: apt-get install jq  # Linux
```

### Required Accounts

1. **Railway Account**
   - Sign up at [railway.app](https://railway.app)
   - Verify email address
   - Add payment method (free tier available)

2. **OpenRouter Account**
   - Sign up at [openrouter.ai](https://openrouter.ai)
   - Generate API key
   - Add credits or payment method

### Environment Setup

```bash
# Railway authentication
railway login

# Set OpenRouter API key
export OPENROUTER_API_KEY="your-key-here"

# Optional: Set default region
export RAILWAY_DEFAULT_REGION="us-west1"
```

## Deployment

### Step 1: Choose a Configuration

Randal provides pre-built posse configurations:

**Full Company Posse** (`examples/railway-posse/full-company.yaml`)
- 10 specialized agents
- Covers all business functions
- ~$225/month
- Best for: Complete business operations

**Custom Posse**
- Create your own configuration
- Choose only needed specialists
- Scale resources as needed
- Best for: Specific use cases

### Step 2: Deploy with Script

```bash
# Deploy full company posse
./scripts/deploy-railway-posse.sh examples/railway-posse/full-company.yaml

# Or with custom name
./scripts/deploy-railway-posse.sh --name my-posse --config custom-posse.yaml

# Dry run to preview
./scripts/deploy-railway-posse.sh --dry-run examples/railway-posse/full-company.yaml
```

### Step 3: Verify Deployment

```bash
# Check project status
railway status

# Check Meilisearch health
railway logs -s meilisearch | grep "healthy"

# Check agent status
railway logs -s product-engineering | grep "initialized"
```

### Step 4: Test Agent Communication

```bash
# Check Meilisearch variables
railway variable list -s meilisearch -k

# Agents access Meilisearch via private networking:
#   ${{meilisearch.RAILWAY_PRIVATE_DOMAIN}}
# (Agents should automatically discover each other via Meilisearch)

# Send a test task
# (Implementation depends on your Randal client setup)
```

## Configuration

### Posse Configuration File

```yaml
# Metadata
posse:
  name: "my-posse"
  description: "Description"
  version: "1.0.0"

# Shared infrastructure
shared:
  meilisearch:
    plan: "pro"          # Railway plan
    memory: "4Gi"        # Memory allocation
    cpu: "2"             # CPU cores
    storage: "20Gi"      # Persistent storage

# Agent definitions
agents:
  - name: "agent-name"
    role: "agent-role"
    
    # Agent expertise
    expertise:
      - "skill1"
      - "skill2"
      - "skill3"
    
    specialization: "One-line description"
    expertise_file: "path/to/expertise.md"
    
    # Resource allocation
    resources:
      memory: "2Gi"
      cpu: "1"
    
    # Scaling
    replicas: 1
    
    # Optional: Environment variables
    env:
      CUSTOM_VAR: "value"

# Routing rules
routing:
  rules:
    - keywords: ["keyword1", "keyword2"]
      route_to: "agent-name"
```

### Base Configuration

All agents inherit from `archetypes/base.config.yaml`:

```yaml
model:
  provider: anthropic
  name: claude-sonnet-4.5
  temperature: 0.7
  max_tokens: 8192

memory:
  enabled: true
  meilisearch:
    # Set via environment variables
    index_prefix: "randal"

behavior:
  communication:
    tone: "professional"
    verbosity: "balanced"
    emoji: false

security:
  secret_scanning: true
  pre_commit_review: true
  respect_gitignore: true
```

### Expertise Profiles

Each agent requires a detailed expertise profile in markdown:

```markdown
# Agent Name Expertise Profile

## Overview
What this agent does, its role, capabilities

## Core Technical Skills
### Category 1
- Skill 1
- Skill 2

### Category 2
- Skill 3
- Skill 4

## Common Problem Domains
What problems this agent typically solves

## Debugging & Troubleshooting
How this agent approaches debugging

## Communication & Collaboration
How this agent works with other specialists

## Key Strengths Summary
- Strength 1
- Strength 2
```

## Operations

### Managing Agents

```bash
# View agent logs
railway logs -s agent-name

# Follow logs in real-time
railway logs -s agent-name --follow

# Restart an agent (redeploy the service)
railway up -s agent-name

# Note: Scaling (replicas) and stop/start are managed via
# the Railway dashboard or numReplicas in railway.toml
```

### Managing the Posse

```bash
# List all posses
./scripts/list-railway-posses.sh

# Get posse status
railway status

# Update environment variables
railway variable set KEY=value -s agent-name

# Delete a posse
./scripts/delete-railway-posse.sh posse-name
```

### Updating Agents

```bash
# Update agent code (redeploy from current directory)
railway up -s agent-name

# Update environment variables
railway variable set AGENT_EXPERTISE="new,skills" -s agent-name

# Update resources
# (Must be done via Railway dashboard or API)
```

## Monitoring

### Health Checks

Each agent exposes a health check endpoint:

```bash
# Check agent health
curl https://<agent-url>/health

# Expected response
{
  "status": "healthy",
  "agent": "product-engineering",
  "meilisearch": "connected",
  "model": "available",
  "uptime": 3600
}
```

### Logs

```bash
# View recent logs
railway logs -s agent-name

# Search logs
railway logs -s agent-name | grep "ERROR"

# Export logs
railway logs -s agent-name > agent-logs.txt
```

### Metrics

Railway provides built-in metrics:
- CPU usage
- Memory usage
- Network traffic
- Request count
- Response time

Access via Railway dashboard: https://railway.app/dashboard

### Alerts

Set up alerts in Railway dashboard:
1. Go to project settings
2. Configure alerts
3. Set thresholds (CPU, memory, errors)
4. Add notification channels (email, Slack, webhook)

## Troubleshooting

### Common Issues

#### Agents Can't Connect to Meilisearch

**Symptoms**: Agents fail to start, error logs show connection refused

**Solutions**:
```bash
# 1. Check Meilisearch is running
railway logs -s meilisearch

# 2. Verify environment variables
railway variable list -s agent-name -k | grep MEILISEARCH

# 3. Check Meilisearch health (via private networking from another service)
# Meilisearch uses Railway private networking, not a public URL

# 4. Verify master key is correct
railway variable list -s meilisearch -k | grep MASTER_KEY
```

#### Agent Out of Memory

**Symptoms**: Agent crashes, OOM errors in logs

**Solutions**:
```bash
# 1. Check memory usage
railway logs -s agent-name | grep "memory"

# 2. Increase memory allocation
# (Railway dashboard → Service settings → Resources)

# 3. Monitor after redeploy
railway up -s agent-name
railway logs -s agent-name --follow
```

#### Agent Not Responding

**Symptoms**: No logs, no response to requests

**Solutions**:
```bash
# 1. Check service status
railway status

# 2. Redeploy agent
railway up -s agent-name

# 3. Check recent logs
railway logs -s agent-name

# 4. Verify environment variables
railway variable list -s agent-name -k
```

#### High Costs

**Symptoms**: Unexpected Railway bills

**Solutions**:
```bash
# 1. Check resource usage
# (Railway dashboard → Usage tab)

# 2. Remove unused services or scale to 0 replicas
# (Railway dashboard → Service settings)

# 3. Reduce resource allocations
# (Railway dashboard → Service settings)

# 4. Monitor costs
# (Railway dashboard → Billing)
```

### Getting Help

1. **Railway Support**: https://railway.app/help
2. **Railway Discord**: https://discord.gg/railway
3. **Randal Issues**: https://github.com/your-org/randal/issues
4. **Community Forum**: [Your forum link]

## Cost Management

### Cost Breakdown

**Full Company Posse** (~$225/month):
```
Meilisearch:     $50  (4GB RAM, 2 vCPU)
10 Agents:       $175 (11GB RAM total, 6.5 vCPU total)
```

**Minimal Posse** (~$50-100/month):
```
Meilisearch:     $25  (2GB RAM, 1 vCPU)
3-5 Agents:      $25-75 (3-6GB RAM total, 2-3 vCPU total)
```

### Cost Optimization Strategies

#### 1. Right-Size Resources

Resource allocation (memory, CPU) is managed via the Railway dashboard,
not in configuration files. Start small and scale up based on actual usage.

#### 2. Scale Down Off-Hours

Use the Railway dashboard to manage service scaling, or set `numReplicas`
in `railway.toml` and redeploy as needed.

#### 3. Deploy Only Needed Agents

Start with core agents, add specialists as needed:
- Product Engineering
- Platform Infrastructure
- Security & Compliance

Add others when you need them:
- Data Intelligence
- Design Experience
- etc.

#### 4. Use Railway Free Tier

Railway offers $5/month free credit:
- Good for testing
- Small posses (1-2 agents)
- Development environments

### Monitoring Costs

```bash
# View current project status
railway status

# Set budget alerts and review costs via the Railway dashboard:
#   https://railway.app/dashboard → Billing
```

## Best Practices

### Security

1. **Protect Meilisearch Master Key**
   - Never commit to version control
   - Rotate periodically
   - Store in password manager

2. **Limit Public Exposure**
   - Keep agents internal-only
   - Use Railway's private networking
   - Only expose necessary services

3. **Environment Variables**
   - Use Railway's encrypted variables
   - Never log secrets
   - Rotate API keys regularly

### Performance

1. **Resource Allocation**
   - Start small, scale up as needed
   - Monitor actual usage vs allocation
   - Use metrics to right-size

2. **Meilisearch Optimization**
   - Regular index optimization
   - Monitor index size
   - Set appropriate retention policies

3. **Agent Efficiency**
   - Monitor token usage
   - Optimize prompts
   - Cache common queries

### Reliability

1. **Health Checks**
   - Implement comprehensive health checks
   - Monitor regularly
   - Set up alerts

2. **Graceful Degradation**
   - Agents should handle specialist unavailability
   - Implement fallbacks
   - Timeout appropriately

3. **Logging**
   - Log important events
   - Structure logs for searchability
   - Retain logs appropriately

### Development Workflow

1. **Test Locally First**
   - Test agent configurations locally
   - Use `--dry-run` flag
   - Validate YAML syntax

2. **Deploy to Staging**
   - Create a staging posse
   - Test thoroughly
   - Verify agent communication

3. **Production Deployment**
   - Use version tags
   - Deploy during low-traffic periods
   - Monitor closely after deployment

### Documentation

1. **Document Custom Configurations**
   - Keep README for each posse
   - Document routing rules
   - Explain specializations

2. **Expertise Profiles**
   - Keep expertise profiles updated
   - Add examples and use cases
   - Document limitations

3. **Runbooks**
   - Create runbooks for common operations
   - Document troubleshooting steps
   - Include escalation procedures

## Advanced Topics

### Custom Agent Development

Create custom agents for specific needs:

1. Write expertise profile
2. Define agent configuration
3. Deploy to posse
4. Test delegation and communication

### Multi-Region Deployment

Deploy agents in multiple regions for lower latency:

```yaml
agents:
  - name: "agent-us"
    region: "us-west1"
  - name: "agent-eu"
    region: "europe-west1"
```

### High Availability

Implement HA for critical agents by setting `numReplicas` in `railway.toml`:

```toml
[deploy]
numReplicas = 2
```

Resource allocation (memory, CPU) is configured via the Railway dashboard.

### Automated Scaling

Implement auto-scaling based on demand:
- Use Railway's auto-scaling features
- Set min/max replicas
- Configure scaling triggers

## Conclusion

Railway posse deployment provides a scalable, cost-effective way to run multiple specialized Randal agents. Follow this guide to deploy, operate, and optimize your posse for maximum efficiency and reliability.

## Additional Resources

- [Railway Documentation](https://docs.railway.app)
- [Meilisearch Documentation](https://docs.meilisearch.com)
- [Randal Repository](https://github.com/your-org/randal)
- [OpenRouter Documentation](https://openrouter.ai/docs)

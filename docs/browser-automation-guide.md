# Browser Automation Guide

Randal can control a Chromium-based browser via the Chrome DevTools Protocol
(CDP). This enables web scraping, form filling, testing, screenshot capture,
and any task that requires interacting with a web page.

---

## Overview

The browser automation system uses CDP to launch and control a Chromium
instance. The runner exposes a set of browser tools that agents can invoke
during a job. All browser operations run in a single persistent browser
context, so cookies, sessions, and state carry across tool calls within a
job.

```
Runner ──► Browser tools ──► CDP ──► Chromium
                                       │
                                  ┌────┴────┐
                                  │ Web page │
                                  └─────────┘
```

---

## Configuration

Enable browser automation in your config:

```yaml
browser:
  enabled: true
  headless: true                   # false to see the browser window
  profileDir: ./browser-profile    # persist cookies/sessions across jobs
  sandbox: false                   # restrict navigation to allowlisted domains
  viewport:
    width: 1280
    height: 720
  timeout: 30000                   # ms, default timeout for operations
```

### Configuration reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable browser automation |
| `headless` | boolean | `true` | Run without a visible window |
| `profileDir` | string | — | Directory for persistent browser profile |
| `sandbox` | boolean | `false` | Enable domain allowlisting |
| `viewport.width` | number | `1280` | Browser viewport width in pixels |
| `viewport.height` | number | `720` | Browser viewport height in pixels |
| `timeout` | number | `30000` | Default timeout in milliseconds |

---

## Available browser tools

When browser automation is enabled, the following tools are available to the
agent during a job:

### `browser_navigate`

Navigate to a URL.

```json
{
  "tool": "browser_navigate",
  "arguments": {
    "url": "https://example.com",
    "waitUntil": "networkidle"
  }
}
```

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `url` | string | required | The URL to navigate to |
| `waitUntil` | string | `"load"` | Wait condition: `"load"`, `"domcontentloaded"`, `"networkidle"` |

### `browser_screenshot`

Capture a screenshot of the current page.

```json
{
  "tool": "browser_screenshot",
  "arguments": {
    "fullPage": false,
    "selector": "#main-content"
  }
}
```

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `fullPage` | boolean | `false` | Capture the entire scrollable page |
| `selector` | string | — | CSS selector to screenshot a specific element |

Returns a base64-encoded PNG image.

### `browser_click`

Click an element on the page.

```json
{
  "tool": "browser_click",
  "arguments": {
    "selector": "button.submit",
    "button": "left"
  }
}
```

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `selector` | string | required | CSS selector for the element to click |
| `button` | string | `"left"` | Mouse button: `"left"`, `"right"`, `"middle"` |

### `browser_type`

Type text into an input element.

```json
{
  "tool": "browser_type",
  "arguments": {
    "selector": "input[name='email']",
    "text": "user@example.com",
    "delay": 50
  }
}
```

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `selector` | string | required | CSS selector for the input element |
| `text` | string | required | Text to type |
| `delay` | number | `0` | Delay between keystrokes in ms (simulates human typing) |

### `browser_evaluate`

Execute arbitrary JavaScript in the page context.

```json
{
  "tool": "browser_evaluate",
  "arguments": {
    "expression": "document.title"
  }
}
```

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `expression` | string | required | JavaScript expression to evaluate |

Returns the serialised result of the expression.

### `browser_getContent`

Get the text content or HTML of the page or a specific element.

```json
{
  "tool": "browser_getContent",
  "arguments": {
    "selector": "article",
    "format": "text"
  }
}
```

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `selector` | string | — | CSS selector (omit for full page) |
| `format` | string | `"text"` | `"text"` for readable text, `"html"` for raw HTML |

### `browser_getSnapshot`

Get an accessibility tree snapshot of the page. This is useful for
understanding page structure without visual rendering.

```json
{
  "tool": "browser_getSnapshot",
  "arguments": {}
}
```

Returns a structured accessibility tree with roles, names, and values for
all interactive elements.

---

## Profile persistence

By default, each job starts with a clean browser context. Set `profileDir` to
persist state across jobs:

```yaml
browser:
  enabled: true
  profileDir: ./browser-profile
```

The profile directory stores:

- **Cookies** — stay logged into sites across jobs
- **Local storage** — preserve application state
- **Session storage** — maintain form data and preferences
- **Cache** — speed up repeated page loads

The profile directory is created automatically on first use. To reset the
browser state, delete the directory.

### When to use profiles

| Scenario | Profile? | Reason |
|----------|----------|--------|
| Web scraping public pages | No | No state needed |
| Logging into a dashboard | Yes | Avoid re-authenticating every job |
| Testing a web app | No | Clean state for reproducible tests |
| Monitoring a service | Yes | Maintain session cookies |

---

## Docker headless setup

When running Randal in Docker, browser automation requires a Chromium
installation in the container. The official Randal Docker image includes
Chromium.

If you're building a custom image, add Chromium:

```dockerfile
FROM oven/bun:1

# Install Chromium and dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libgbm1 \
    libnss3 \
    libxss1 \
    libasound2 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV CHROMIUM_PATH=/usr/bin/chromium
```

In Docker, always use headless mode:

```yaml
browser:
  enabled: true
  headless: true
```

### Docker Compose example

```yaml
services:
  randal:
    image: ghcr.io/drewbietron/randal:latest
    volumes:
      - ./randal.config.yaml:/app/randal.config.yaml
      - ./workspace:/app/workspace
      - browser-profile:/app/browser-profile
    environment:
      - API_TOKEN=${API_TOKEN}

volumes:
  browser-profile:
```

---

## Sandbox mode

When `browser.sandbox` is `true`, navigation is restricted to prevent the
agent from accessing unintended sites. Configure allowed domains in the
runner's service allowlist:

```yaml
browser:
  enabled: true
  sandbox: true

services:
  browser:
    description: Browser automation
    credentials:
      type: none
      binaries: [chromium]
```

In sandbox mode:

- `browser_navigate` only allows URLs matching configured domain patterns.
- `browser_evaluate` is disabled to prevent arbitrary JavaScript execution.
- External resource loading (images, scripts, fonts from other domains) is
  blocked.

Use sandbox mode when:

- The agent processes untrusted input that might contain URLs.
- You want to limit the agent's web access to specific internal tools.
- Compliance requirements restrict outbound network access.

---

## Common patterns

### Screenshot and analyse

```
1. browser_navigate → https://dashboard.example.com
2. browser_screenshot → capture the current state
3. (Agent analyses the screenshot and decides next steps)
```

### Fill a form

```
1. browser_navigate → https://app.example.com/form
2. browser_type → fill in each field
3. browser_click → submit the form
4. browser_getContent → read the confirmation page
```

### Scrape structured data

```
1. browser_navigate → https://site.example.com/data
2. browser_evaluate → extract data with JavaScript
3. (Agent processes and returns the data)
```

### Monitor a page

```
1. browser_navigate → https://status.example.com
2. browser_getSnapshot → get accessibility tree
3. (Agent checks for specific conditions)
4. (Report findings back to the user)
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Browser fails to launch | Chromium not installed | Install Chromium or use the official Docker image |
| Timeout on navigate | Page takes too long to load | Increase `timeout` or use `waitUntil: "domcontentloaded"` |
| Screenshots are blank | Headless rendering issue | Try `headless: false` locally to debug |
| Login state lost between jobs | No profile configured | Set `profileDir` |
| "Navigation blocked" error | Sandbox mode active | Add the domain to allowed list or disable sandbox |
| Element not found | Dynamic content not loaded | Add a wait or use `waitUntil: "networkidle"` |

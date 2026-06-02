# syntax=docker/dockerfile:1

# ── Stage 1: clone repo ──────────────────────────────────────────────────────
FROM alpine/git:2.45.2 AS repo-clone

ARG REPO_URL=https://github.com/mukul975/Anthropic-Cybersecurity-Skills.git
ARG REPO_BRANCH=main

WORKDIR /repo
RUN git clone --depth=1 --branch ${REPO_BRANCH} ${REPO_URL} .

# ── Stage 2: install dependencies ────────────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts

# ── Stage 3: final image ──────────────────────────────────────────────────────
FROM node:22-alpine AS final

# git not needed at runtime; keep image small
RUN apk add --no-cache tini

WORKDIR /app

# Copy MCP server source
COPY server.js ./
COPY package.json ./

# Copy node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy cloned skills repo
COPY --from=repo-clone /repo /skills-repo

# Non-root user
RUN addgroup -S mcp && adduser -S mcp -G mcp \
    && chown -R mcp:mcp /app /skills-repo

USER mcp

ENV NODE_ENV=production \
    PORT=3000 \
    SKILLS_DIR=/skills-repo/skills \
    INDEX_PATH=/skills-repo/index.json \
    RATE_LIMIT_MAX=100
    # MCP_AUTH_TOKEN is injected at runtime — do NOT bake it in

EXPOSE 3000

# tini as PID 1 for proper signal handling
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:3000/health || exit 1

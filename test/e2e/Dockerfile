FROM oven/bun:latest

RUN apt-get update && apt-get install -y curl git jq python3 && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

# Install agentgrit from local source instead of npm
WORKDIR /agentgrit-src
COPY package.json ./
COPY dist/ ./dist/
COPY rubrics/ ./rubrics/
COPY agentgrit.config.ts ./
RUN npm install -g .

WORKDIR /test
COPY test/e2e/test-data/ /test/test-data/
COPY test/e2e/phase1-clean-install.sh test/e2e/phase2-integration.sh test/e2e/phase3b-coexistence.sh test/e2e/phase4-parity-gaps.sh /test/
RUN chmod +x /test/*.sh

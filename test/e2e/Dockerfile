FROM oven/bun:latest

RUN apt-get update && apt-get install -y curl git jq python3 && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install local build of agentgrit instead of npm version
COPY local-pkg/ /opt/agentgrit/
RUN cd /opt/agentgrit && npm install -g .

WORKDIR /test
COPY test-data/ /test/test-data/
COPY phase1-clean-install.sh phase2-integration.sh phase3b-coexistence.sh /test/
RUN chmod +x /test/*.sh

import type { AgentGritConfig } from "./src/adapters/types";

// Quick Start — zero API keys, manual review only
export const quick: AgentGritConfig = {
  signalDir: "~/.agentgrit/signals",
  adapter: "local",
  rubrics: ["starter.json"],
  rules: {
    globalBudget: 25,
    projectBudget: 25,
    autoPromote: false,
  },
  daemon: {
    interval: "0",
    weeklyDay: "sunday",
  },
  learningCaps: {
    templateCap: 8,
    gateStagingCap: 5,
    questionnaireCap: 10,
    claudeMdStagingCap: 3,
  },
};

// Standard — one API key, LLM judge + graph, human-gated promotion
export const standard: AgentGritConfig = {
  signalDir: "~/.agentgrit/signals",
  adapter: "local",
  judge: {
    provider: "gemini",
    model: "gemini-2.5-flash",
  },
  rubrics: ["starter.json"],
  rules: {
    globalBudget: 25,
    projectBudget: 25,
    autoPromote: false,
  },
  daemon: {
    interval: "30m",
    weeklyDay: "sunday",
  },
  learningCaps: {
    templateCap: 8,
    gateStagingCap: 5,
    questionnaireCap: 10,
    claudeMdStagingCap: 3,
  },
};

// Full Auto — daemon + optimizer + graph + optional Langfuse
export const full: AgentGritConfig = {
  signalDir: "~/.agentgrit/signals",
  adapter: "both",
  langfuse: {
    publicKey: "",
    secretKey: "",
    baseUrl: "https://us.cloud.langfuse.com",
  },
  judge: {
    provider: "gemini",
    model: "gemini-2.5-flash",
  },
  rubrics: ["starter.json"],
  rules: {
    globalBudget: 25,
    projectBudget: 25,
    autoPromote: true,
  },
  daemon: {
    interval: "30m",
    weeklyDay: "sunday",
  },
  learningCaps: {
    templateCap: 8,
    gateStagingCap: 5,
    questionnaireCap: 10,
    claudeMdStagingCap: 3,
  },
};

export default standard;

export interface AgentGritConfig {
  signalDir: string;
  adapter: 'local' | 'langfuse' | 'both';
  langfuse?: {
    publicKey: string;
    secretKey: string;
    baseUrl: string;
  };
  judge?: {
    provider: 'gemini' | 'claude' | 'openai';
    model: string;
    apiKey: string;
  };
  rubrics: string[];
  rules: {
    globalBudget: number;
    projectBudget: number;
    autoPromote: boolean;
  };
  daemon: {
    interval: string;
    weeklyDay: string;
  };
}

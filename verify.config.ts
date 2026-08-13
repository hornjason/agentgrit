import type { VerifyConfig } from '../.claude/verify/run.ts'

const config: VerifyConfig = {
  name: 'agentgrit',
  root: '~/agentgrit',
  tests: [
    {
      name: 'ADR-004 compliance',
      category: 'drift',
      command: 'bun test test/compliance/adr-004.test.ts',
    },
    {
      name: 'ADR-005 compliance',
      category: 'drift',
      command: 'bun test test/compliance/adr-005.test.ts',
    },
    {
      name: 'Doctor health check',
      category: 'agent',
      command: 'node dist/agentgrit.js doctor',
    },
  ],
}

export default config

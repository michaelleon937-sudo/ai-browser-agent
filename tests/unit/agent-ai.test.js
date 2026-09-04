// tests/unit/agent-ai.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { getProvider, isKnownTool, isSensitive, ACTION_TOOLS } from '../../agent/ai/index.js';

describe('agent/ai', () => {
  beforeEach(() => {
    process.env.AI_PROVIDER = 'stub';
  });

  it('resolves the stub provider by default in tests', async () => {
    const provider = getProvider();
    expect(provider.name).toBe('stub');
  });

  it('recognizes all declared ACTION_TOOLS as known tools', () => {
    for (const tool of ACTION_TOOLS) {
      expect(isKnownTool(tool.name)).toBe(true);
    }
  });

  it('rejects unknown tool names', () => {
    expect(isKnownTool('delete_everything')).toBe(false);
  });

  it('flags checkout/payment navigation as sensitive when approval is required', () => {
    process.env.HUMAN_APPROVAL_REQUIRED = 'true';
    const sensitive = isSensitive('browser_navigate', { url: 'https://shop.example.com/checkout' });
    expect(sensitive).toBe(true);
  });

  it('does not flag a plain navigation as sensitive', () => {
    process.env.HUMAN_APPROVAL_REQUIRED = 'true';
    const sensitive = isSensitive('browser_navigate', { url: 'https://example.com' });
    expect(sensitive).toBe(false);
  });

  it('the stub provider returns a navigate action first for a fresh goal', async () => {
    const provider = getProvider();
    const { action } = await provider.nextAction({
      goal: 'Go to example.com and check the status code',
      history: { steps: [] },
      observation: {},
      availableTools: ACTION_TOOLS,
    });
    expect(action.tool).toBe('browser_navigate');
  });

  it('the stub provider eventually completes the task', async () => {
    const provider = getProvider();
    let history = { steps: [] };
    let last;
    for (let i = 0; i < 5; i++) {
      const { action, done } = await provider.nextAction({
        goal: 'Go to example.com and check the status code',
        history,
        observation: {},
        availableTools: ACTION_TOOLS,
      });
      history.steps.push({ tool: action.tool, action, status: 'success' });
      last = { action, done };
      if (done) break;
    }
    expect(last.action.tool).toBe('task_complete');
  });
});

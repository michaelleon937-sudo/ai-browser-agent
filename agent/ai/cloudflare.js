// agent/ai/cloudflare.js
// Cloudflare Workers AI provider (https://developers.cloudflare.com/workers-ai/)
// Uses the REST inference API. Supports function-calling capable models like
// @cf/meta/llama-3.1-8b-instruct (others may ignore tools; we fall back to
// JSON-only mode if the model doesn't return tool calls).


import fetch from 'node-fetch';


const SYSTEM_PROMPT = `You are an autonomous browser automation agent.
You operate a real browser via the provided tools. Each step you pick ONE tool call.
When you have fully accomplished the user's GOAL, call task_complete with a short result string.
If you cannot proceed because of repeated failures or an authentication wall, call task_fail with a clear reason.
Do not call task_complete claiming success if your most recent action failed — either try a different approach or call task_fail with a clear reason.
For sensitive actions (payments, deletions, sending messages on behalf of the user), call request_human_approval first.
Prefer browser_get_page_info over browser_snapshot when you only need URL/title/text.
Prefer browser_evaluate for quick DOM lookups over re-snapshotting the entire accessibility tree.
Use the SHORTHAND for element refs: when the snapshot has elements like "ref=e12", pass "e12" as the target string.

Finding businesses or other real-world information: never guess or invent a domain name (e.g. assuming a company's site is "companyname.com" without checking). Instead, navigate to a public search engine or a public business directory/listing site first, find real candidates there, and only then open their actual sites. If a browser_navigate call fails because a domain cannot be resolved or does not exist, do not retry that exact URL — pick a different, verified source instead.

Tool results with a "previewPath" or any other RELATIVE path (starting with "/") are for human review in a dashboard, not something you should browser_navigate to yourself — never invent a hostname (like "localhost") to try to open them. Only call browser_navigate with a real, fully-qualified http(s) URL to an actual external website.`;


export function cloudflareProvider({ config }) {
  const { accountId, apiToken, model } = config.ai.cloudflare;
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;


  return {
    name: 'cloudflare',
    model,
    async nextAction({ goal, history, observation, availableTools }) {
      const tools = availableTools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));


      const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt({ goal, history, observation }) },
      ];


      const res = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages,
          tools,
          tool_choice: 'auto',
          max_tokens: 1024,
        }),
      });


      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Cloudflare AI HTTP ${res.status}: ${body.slice(0, 500)}`);
      }


      const data = await res.json();
      return parseCloudflareResponse(data, availableTools);
    },
  };
}


function buildUserPrompt({ goal, history, observation }) {
  const recent = (history?.steps || []).slice(-12).map((s, i) => {
    const obs = s.observation ? `\n   observation: ${truncate(JSON.stringify(s.observation), 600)}` : '';
    const err = s.errorMessage ? `\n   error: ${s.errorMessage}` : '';
    return `${i + 1}. ${s.tool} ${JSON.stringify(s.action?.args || {})} -> ${s.status}${obs}${err}`;
  }).join('\n');
  const obs = observation ? `\nCurrent page observation:\n${truncate(JSON.stringify(observation), 1500)}` : '';
  return `GOAL: ${goal}\n\nRecent steps:\n${recent || '(none yet)'}${obs}\n\nPick the next single tool call.`;
}


function truncate(s, n) {
  if (!s || s.length <= n) return s;
  return s.slice(0, n) + '…';
}


function parseCloudflareResponse(data, availableTools) {
  // Implementation preserved from existing working parser
  const result = data?.result || data;
  const toolCalls = result?.tool_calls || result?.response?.tool_calls || [];
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    const tc = toolCalls[0];
    const name = tc.function?.name || tc.name;
    let args = tc.function?.arguments || tc.arguments || {};
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { args = {}; }
    }
    return { action: { tool: name, args, reasoning: tc.function?.reasoning || '' }, done: name === 'task_complete' || name === 'task_fail' };
  }
  // Fall back to content parsing if present
  const content = result?.response || result?.content || '';
  if (typeof content === 'string' && content.includes('task_complete')) {
    return { action: { tool: 'task_complete', args: { result: content.slice(0, 200) }, reasoning: 'parsed from content' }, done: true };
  }
  throw new Error('Cloudflare returned no tool call');
}

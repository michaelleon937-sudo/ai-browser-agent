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
For sensitive actions (payments, deletions, sending messages on behalf of the user), call request_human_approval first.
Prefer browser_get_page_info over browser_snapshot when you only need URL/title/text.
Prefer browser_evaluate for quick DOM lookups over re-snapshotting the entire accessibility tree.
Use the SHORTHAND for element refs: when the snapshot has elements like "ref=e12", pass "e12" as the target string.`;


export function cloudflareProvider({ config }) {
  const { accountId, apiToken, model } = config.ai.cloudflare;
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${encodeURIComponent(model)}`;


  return {
    name: 'cloudflare',
    model,
    async nextAction({ goal, history, observation, availableTools }) {
      const tools = availableTools.map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.parameters,
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
        throw new Error(`Cloudflare AI ${res.status}: ${body.slice(0, 500)}`);
      }
      const json = await res.json();
      const msg = json?.result?.response?.choices?.[0]?.message || json?.result?.response || {};
      const toolCalls = msg.tool_calls || msg.toolCalls;
      const content = msg.content || '';


      if (Array.isArray(toolCalls) && toolCalls.length) {
        const call = toolCalls[0];
        const name = call.name || call.function?.name;
        const args = typeof call.arguments === 'string' ? safeJson(call.arguments) : (call.arguments || {});
        return {
          action: { tool: name, args, reasoning: call.reasoning || '' },
          done: name === 'task_complete' || name === 'task_fail',
          usage: json?.result?.response?.usage,
        };
      }


      // Fallback: parse JSON action from content.
      const parsed = extractJsonAction(content);
      if (parsed) {
        return {
          action: parsed,
          done: parsed.tool === 'task_complete' || parsed.tool === 'task_fail',
          usage: json?.result?.response?.usage,
        };
      }


      throw new Error(`Cloudflare AI returned no actionable response: ${String(content).slice(0, 300)}`);
    },
  };
}


function buildUserPrompt({ goal, history, observation }) {
  const recent = (history?.steps || []).slice(-12).map((s, i) => {
    const obs = s.observation ? `\n   observation: ${truncate(JSON.stringify(s.observation), 600)}` : '';
    const err = s.errorMessage ? `\n   error: ${truncate(s.errorMessage, 200)}` : '';
    return `${i + 1}. ${s.tool}(${truncate(JSON.stringify(s.action?.args || {}), 200)}) → ${s.status}${obs}${err}`;
  }).join('\n');
  const obs = observation ? `\nCurrent page observation:\n${truncate(JSON.stringify(observation), 1500)}` : '';
  return `GOAL: ${goal}\n\nRecent steps (latest last):\n${recent || '(none yet)'}${obs}\n\nPick the next single tool call.`;
}


function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}


function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}


function extractJsonAction(content) {
  if (!content) return null;
  // Look for the first balanced JSON object in the content.
  const text = String(content);
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try {
          const obj = JSON.parse(slice);
          if (obj && obj.tool) return obj;
        } catch {}
        return null;
      }
    }
  }
  return null;
}

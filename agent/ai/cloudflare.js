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
          max_tokens: 2048,
        }),
      });


      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Cloudflare AI HTTP ${res.status}: ${body.slice(0, 500)}`);
      }


      const json = await res.json();
      const { toolCalls, content } = normalizeCloudflareResponse(json);

      if (Array.isArray(toolCalls) && toolCalls.length) {
        const call = toolCalls[0];
        const fn = call.function || call;
        const name = fn.name;
        const rawArgs = fn.arguments;
        const args = typeof rawArgs === 'string' ? safeJson(rawArgs) : (rawArgs || {});

        return {
          action: { tool: name, args, reasoning: call.reasoning || '' },
          done: name === 'task_complete' || name === 'task_fail',
        };
      }

      // Fallback: parse JSON action from content.
      const parsed = extractJsonAction(content);
      if (parsed) {
        return {
          action: parsed,
          done: parsed.tool === 'task_complete' || parsed.tool === 'task_fail',
        };
      }

      // Some models emit the whole action as bare JSON content
      if (content && content.trim().startsWith('{')) {
        try {
          const direct = JSON.parse(content);
          // Restore 1138232 fallback: { result: string } → task_complete
          if (direct && typeof direct.result === 'string') {
            return {
              action: {
                tool: 'task_complete',
                args: { result: direct.result },
                reasoning: '',
              },
              done: true,
            };
          }
          if (direct && (direct.tool || direct.name)) {
            return {
              action: {
                tool: direct.tool || direct.name,
                args: direct.args || direct.arguments || {},
                reasoning: direct.reasoning || '',
              },
              done: (direct.tool || direct.name) === 'task_complete' || (direct.tool || direct.name) === 'task_fail',
            };
          }
          // Ambiguous bare JSON that looks like tool args for a unique tool
          const matched = matchUniqueTool(direct, availableTools);
          if (matched) {
            return {
              action: { tool: matched.name, args: direct, reasoning: '' },
              done: matched.name === 'task_complete' || matched.name === 'task_fail',
            };
          }
        } catch { /* fall through */ }
      }

      throw new Error(`Cloudflare AI returned no actionable response: ${String(content).slice(0, 300)}`);
    },
  };
}


/**
 * Normalize Cloudflare Workers AI REST response shapes into a uniform
 * { toolCalls, content } pair.
 *
 * Documented text shape: { result: { response: "<string>" } }
 * Object / OpenAI-ish shapes (from various models and earlier parsers):
 *   result.choices[0].message
 *   result.response.choices[0].message
 *   result.response as { content, tool_calls }
 *   result.tool_calls at top level
 */
export function normalizeCloudflareResponse(json) {
  const result = json?.result;

  // Prefer explicit message objects (OpenAI-compatible / choices shapes).
  const msg =
    result?.choices?.[0]?.message ||
    result?.response?.choices?.[0]?.message ||
    (result?.response && typeof result.response === 'object' && !Array.isArray(result.response)
      ? result.response
      : null) ||
    result?.message ||
    null;

  const toolCalls =
    (msg && (msg.tool_calls || msg.toolCalls)) ||
    result?.tool_calls ||
    result?.response?.tool_calls ||
    [];

  // Critical production fix: when result.response is a plain string (the
  // documented Cloudflare REST shape for @cf/meta/llama-3.1-8b-instruct),
  // treat that string as content so extractJsonAction / bare-JSON fallbacks run.
  let content = '';
  if (typeof result?.response === 'string') {
    content = result.response;
  } else if (msg && typeof msg.content === 'string') {
    content = msg.content;
  } else if (typeof msg === 'string') {
    content = msg;
  } else if (typeof result?.response?.content === 'string') {
    content = result.response.content;
  }

  return {
    toolCalls: Array.isArray(toolCalls) ? toolCalls : [],
    content: content || '',
  };
}


function buildUserPrompt({ goal, history, observation }) {
  const recent = (history?.steps || []).slice(-12).map((s, i) => {
    const obs = s.observation ? `\n   observation: ${truncate(JSON.stringify(s.observation), 600)}` : '';
    const err = s.errorMessage ? `\n   error: ${truncate(s.errorMessage, 200)}` : '';
    return `${i + 1}. ${s.tool}(${truncate(JSON.stringify(s.action?.args || {}), 200)}) -> ${s.status}${obs}${err}`;
  }).join('\n');
  const obs = observation ? `\nCurrent page observation:\n${truncate(JSON.stringify(observation), 1500)}` : '';
  return `GOAL: ${goal}\n\nRecent steps (latest last):\n${recent || '(none yet)'}${obs}\n\nPick the next single tool call.`;
}


function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n) + '...' : s;
}


function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}


function extractJsonAction(content) {
  if (!content) return null;
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


function matchUniqueTool(obj, availableTools) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const keys = Object.keys(obj);
  if (keys.length === 0) return null;
  if (!Array.isArray(availableTools)) return null;

  const candidates = availableTools.filter((tool) => {
    const propKeys = Object.keys(tool?.parameters?.properties || {});
    const requiredKeys = Array.isArray(tool?.parameters?.required) ? tool.parameters.required : [];
    const allKeysKnownToTool = keys.every((k) => propKeys.includes(k));
    const allRequiredKeysPresent = requiredKeys.every((k) => keys.includes(k));
    return allKeysKnownToTool && allRequiredKeysPresent;
  });

  return candidates.length === 1 ? candidates[0] : null;
}

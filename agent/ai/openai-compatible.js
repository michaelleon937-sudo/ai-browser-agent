// agent/ai/openai-compatible.js
// OpenAI-compatible chat-completions provider. Works with:
//   - OpenAI
//   - Anthropic-via-gateway (e.g. Cloudflare AI Gateway, Portkey)
//   - Local: Ollama (/v1), llama.cpp server, vLLM, LM Studio
// Uses standard tool-calling via the Chat Completions API.


import fetch from 'node-fetch';


const SYSTEM_PROMPT = `You are an autonomous browser automation agent.
You control a real browser through the provided tools. Choose ONE tool call per turn.
When the user's GOAL is fully accomplished, call task_complete with a concise summary string.
If you are stuck or encounter repeated failures, call task_fail with a clear reason.
For sensitive actions (payments, deletions, sending messages), call request_human_approval first.
Use the ref format from snapshots directly (e.g. "e12") as element targets.
Prefer browser_get_page_info over full snapshots when you only need URL/title/text.`;


export function openaiCompatibleProvider({ config }) {
  const { apiKey, baseURL, model } = config.ai.openai;


  return {
    name: 'openai-compatible',
    model,
    async nextAction({ goal, history, observation, availableTools }) {
      const tools = availableTools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));


      const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt({ goal, history, observation }) },
      ];


      const res = await fetch(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          tools,
          tool_choice: 'auto',
          temperature: 0.2,
          max_tokens: 1024,
        }),
      });


      if (!res.ok) {
        const body = await res.text();
        throw new Error(`OpenAI-compatible ${res.status}: ${body.slice(0, 500)}`);
      }
      const json = await res.json();
      const choice = json?.choices?.[0];
      const msg = choice?.message || {};
      const toolCalls = msg.tool_calls || [];


      if (toolCalls.length) {
        const call = toolCalls[0];
        const name = call.function?.name || call.name;
        const args = typeof call.function?.arguments === 'string'
          ? safeJson(call.function.arguments)
          : (call.function?.arguments || {});
        return {
          action: { tool: name, args, reasoning: msg.content || '' },
          done: name === 'task_complete' || name === 'task_fail',
          usage: json.usage,
        };
      }


      // Fallback: parse JSON action out of plain content.
      const parsed = extractJsonAction(msg.content || '');
      if (parsed) {
        return {
          action: parsed,
          done: parsed.tool === 'task_complete' || parsed.tool === 'task_fail',
          usage: json.usage,
        };
      }
      throw new Error(`OpenAI-compatible returned no tool call or JSON action: ${String(msg.content).slice(0, 300)}`);
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

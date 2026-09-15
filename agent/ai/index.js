// agent/ai/index.js
// AI provider abstraction. The agent calls one provider at a time, configured
// via AI_PROVIDER. Each provider implements:
//   async nextAction({ goal, history, observation, availableTools }) -> {
//     action:  { tool: string, args: object, reasoning: string }
//     done:    boolean
//     usage?:  object
//   }


import { config, validate } from '../../config/index.js';
import { stubProvider } from './stub.js';
import { cloudflareProvider } from './cloudflare.js';
import { openaiCompatibleProvider } from './openai-compatible.js';


const providers = {
  stub: stubProvider,
  cloudflare: cloudflareProvider,
  'openai-compatible': openaiCompatibleProvider,
};


let active;


export function getProvider() {
  if (active) return active;
  const name = config.ai.provider;
  const impl = providers[name];
  if (!impl) {
    throw new Error(
      `Unknown AI_PROVIDER "${name}". Supported: ${Object.keys(providers).join(', ')}`,
    );
  }
  active = impl({ config });
  return active;
}


export function providerName() {
  return config.ai.provider;
}


export function listProviders() {
  return Object.keys(providers);
}


export function validationErrors() {
  return validate();
}


// Shared action validator used by every provider.
const TOOL_NAMES = new Set([
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_hover',
  'browser_type',
  'browser_fill',
  'browser_select_option',
  'browser_press',
  'browser_upload_file',
  'browser_drag',
  'browser_evaluate',
  'browser_get_text',
  'browser_get_page_info',
  'browser_screenshot',
  'browser_tabs',
  'browser_new_tab',
  'browser_close_tab',
  'browser_wait_for',
  'browser_wait_for_text',
  'browser_wait_ms',
  'task_complete',
  'task_fail',
  'request_human_approval',
  'generate_website',
  'analyze_prospect_page',
  'save_prospect',
]);


export const ACTION_TOOLS = [
  {
    type: 'function',
    name: 'browser_navigate',
    description: 'Navigate the active page to an absolute HTTP(S) URL.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute URL, e.g. https://example.com' } },
      required: ['url'],
    },
  },
  { type: 'function', name: 'browser_snapshot', description: 'Take an accessibility-tree snapshot of the current page.', parameters: { type: 'object', properties: { includeBoxes: { type: 'boolean' } } } },
  { type: 'function', name: 'browser_click', description: 'Click an element by accessibility ref or CSS selector.', parameters: { type: 'object', properties: { target: { type: 'string' }, description: { type: 'string' }, doubleClick: { type: 'boolean' }, button: { type: 'string', enum: ['left','middle','right'] } }, required: ['target'] } },
  { type: 'function', name: 'browser_hover', description: 'Hover an element.', parameters: { type: 'object', properties: { target: { type: 'string' }, description: { type: 'string' } }, required: ['target'] } },
  { type: 'function', name: 'browser_type', description: 'Type text into a focused element.', parameters: { type: 'object', properties: { target: { type: 'string' }, text: { type: 'string' }, description: { type: 'string' }, delayMs: { type: 'number' } }, required: ['target','text'] } },
  { type: 'function', name: 'browser_fill', description: 'Clear and fill a form field.', parameters: { type: 'object', properties: { target: { type: 'string' }, value: { type: 'string' }, description: { type: 'string' } }, required: ['target','value'] } },
  { type: 'function', name: 'browser_select_option', description: 'Pick option(s) in a <select>.', parameters: { type: 'object', properties: { target: { type: 'string' }, value: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] } }, required: ['target','value'] } },
  { type: 'function', name: 'browser_press', description: 'Press a keyboard key (Enter, Tab, Escape, ArrowDown, etc).', parameters: { type: 'object', properties: { key: { type: 'string' }, target: { type: 'string' } }, required: ['key'] } },
  { type: 'function', name: 'browser_upload_file', description: 'Upload one or more files to a file input.', parameters: { type: 'object', properties: { target: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } } }, required: ['target','paths'] } },
  { type: 'function', name: 'browser_drag', description: 'Drag from start element to end element.', parameters: { type: 'object', properties: { startTarget: { type: 'string' }, endTarget: { type: 'string' } }, required: ['startTarget','endTarget'] } },
  { type: 'function', name: 'browser_evaluate', description: 'Run a JavaScript function in the page context. The function string must be self-contained.', parameters: { type: 'object', properties: { fn: { type: 'string' }, target: { type: 'string' } }, required: ['fn'] } },
  { type: 'function', name: 'browser_get_text', description: 'Read the innerText of an element.', parameters: { type: 'object', properties: { target: { type: 'string' }, description: { type: 'string' } }, required: ['target'] } },
  { type: 'function', name: 'browser_get_page_info', description: 'Get current URL, title and a short text excerpt of the page.', parameters: { type: 'object', properties: {} } },
  { type: 'function', name: 'browser_screenshot', description: 'Take a screenshot (debug aid).', parameters: { type: 'object', properties: { path: { type: 'string' }, fullPage: { type: 'boolean' } } } },
  { type: 'function', name: 'browser_tabs', description: 'List open tabs.', parameters: { type: 'object', properties: {} } },
  { type: 'function', name: 'browser_new_tab', description: 'Open a new tab, optionally navigating to a URL.', parameters: { type: 'object', properties: { url: { type: 'string' } } } },
  { type: 'function', name: 'browser_close_tab', description: 'Close a tab by index (default: last).', parameters: { type: 'object', properties: { index: { type: 'number' } } } },
  { type: 'function', name: 'browser_wait_for', description: 'Wait for an element to reach a state (visible/hidden/attached/detached).', parameters: { type: 'object', properties: { target: { type: 'string' }, state: { type: 'string', enum: ['visible','hidden','attached','detached'] }, timeoutMs: { type: 'number' } }, required: ['target'] } },
  { type: 'function', name: 'browser_wait_for_text', description: 'Wait until text appears on the page.', parameters: { type: 'object', properties: { text: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['text'] } },
  { type: 'function', name: 'browser_wait_ms', description: 'Wait a fixed number of milliseconds.', parameters: { type: 'object', properties: { ms: { type: 'number' } }, required: ['ms'] } },
  { type: 'function', name: 'task_complete', description: 'Mark the task complete and provide a final result summary.', parameters: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] } },
  { type: 'function', name: 'task_fail', description: 'Abort the task with a clear reason.', parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } },
  { type: 'function', name: 'request_human_approval', description: 'Pause and request human approval before a sensitive action.', parameters: { type: 'object', properties: { what: { type: 'string' }, why: { type: 'string' } }, required: ['what','why'] } },
  {
    type: 'function',
    name: 'generate_website',
    description: 'Generates a speculative real-estate website sample/concept (static HTML/CSS/JS) from structured input. This does NOT publish, deploy, or send the website to anyone — it only creates a local sample the human can review. Do not invent facts (testimonials, awards, stats, property details) that were not provided; use placeholders instead.',
    parameters: {
      type: 'object',
      properties: {
        prospectName: { type: 'string', description: 'Name of the prospect business.' },
        businessType: { type: 'string', description: 'e.g. "Real Estate Agency", "Property Developer".' },
        location: { type: 'string', description: 'City/region the business operates in.' },
        websiteGoal: { type: 'string', description: 'What the sample website should communicate or achieve.' },
        brandStyle: { type: 'string', description: 'e.g. "modern", "luxury", "minimal", "sharp".' },
        primaryColor: { type: 'string', description: 'Hex color, e.g. "#1a2b4c".' },
        secondaryColor: { type: 'string', description: 'Hex color, e.g. "#c9a227".' },
        sections: { type: 'array', items: { type: 'string' }, description: 'Which sections to include, e.g. ["hero","about","services","properties","why","contact","cta","footer"].' },
        services: { type: 'array', items: { type: 'string' }, description: 'Services offered, listed as-is (no invented services).' },
        propertyListings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              location: { type: 'string' },
              price: { type: 'string' },
              description: { type: 'string' },
            },
          },
          description: 'Only include real/provided listings — never fabricate property facts.',
        },
        contactInformation: {
          type: 'object',
          properties: {
            phone: { type: 'string' },
            email: { type: 'string' },
            address: { type: 'string' },
          },
        },
        callToAction: { type: 'string', description: 'Primary call-to-action text, e.g. "Book a viewing".' },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'analyze_prospect_page',
    description: 'Extracts public contact info, social profiles, and service gaps from the text of a page the browser is already looking at (call this after browser_get_page_info or browser_get_text). Purely reads the given text — does not fetch anything itself, invents nothing, and only reports what is actually present in the text.',
    parameters: {
      type: 'object',
      properties: {
        pageText: { type: 'string', description: 'Visible text content of the current page.' },
        pageTitle: { type: 'string', description: 'Title of the current page.' },
        pageUrl: { type: 'string', description: 'URL of the current page.' },
      },
      required: ['pageText'],
    },
  },
  {
    type: 'function',
    name: 'save_prospect',
    description: 'Saves a real-estate business as a prospect for potential outreach, using only public information already gathered (e.g. from analyze_prospect_page). Does NOT contact the prospect, submit anything, or publish anything — it only records the prospect locally for human review.',
    parameters: {
      type: 'object',
      properties: {
        businessName: { type: 'string' },
        websiteUrl: { type: 'string' },
        location: { type: 'string' },
        contactEmail: { type: 'string' },
        contactPhone: { type: 'string' },
        socialProfiles: {
          type: 'array',
          items: { type: 'object', properties: { platform: { type: 'string' }, url: { type: 'string' } } },
        },
        serviceGaps: { type: 'array', items: { type: 'string' }, description: 'Only genuinely observed gaps — never invented.' },
        sourceUrl: { type: 'string', description: 'The public page this information was gathered from.' },
        notes: { type: 'string' },
      },
      required: ['businessName'],
    },
  },
];


export function isKnownTool(name) {
  return TOOL_NAMES.has(name);
}


export const SENSITIVE_TOOLS = new Set([
  'browser_upload_file',
  'browser_press', // keyboard input that could trigger destructive actions; left as is for non-sensitive keys
  'task_complete', // logically not destructive but we may want to confirm critical workflows
]);


// Tools whose args MUST be inspected by the human-approval gate before execution.
export function isSensitive(toolName, args) {
  if (!config.agent.humanApprovalRequired) return false;
  if (toolName === 'task_fail') return false; // failure is always allowed
  if (toolName === 'browser_navigate' && /checkout|payment|confirm|delete|remove|purchase/i.test(String(args?.url || ''))) {
    return true;
  }
  if (toolName === 'browser_upload_file' && (args?.paths || []).length > 0) return true;
  return false;
}

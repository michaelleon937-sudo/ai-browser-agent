// agent/ai/index.js
// AI provider abstraction. The agent calls one provider at a time; this module
// selects the configured provider and exposes a uniform nextAction() contract
// plus the ACTION_TOOLS schema used by every provider.

import { config } from '../../config/index.js';
import { cloudflareProvider } from './cloudflare.js';
import { openaiCompatibleProvider } from './openai-compatible.js';
import { stubProvider } from './stub.js';

const KNOWN_TOOLS = new Set([
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
  'request_human_approval',
  'task_complete',
  'task_fail',
  'generate_website',
  'analyze_prospect_page',
  'save_prospect',
  'analyze_opportunity',
  'save_opportunity',
]);

export function isKnownTool(name) {
  return KNOWN_TOOLS.has(name);
}

export const ACTION_TOOLS = [
  {
    type: 'function',
    name: 'browser_navigate',
    description: 'Navigate the browser to a fully-qualified http(s) URL.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Fully-qualified http(s) URL.' },
        waitUntil: { type: 'string', description: 'Optional wait condition (load, domcontentloaded, networkidle).' },
      },
      required: ['url'],
    },
  },
  {
    type: 'function',
    name: 'browser_snapshot',
    description: 'Capture the accessibility tree of the current page (element refs for click/type).',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'browser_click',
    description: 'Click an element by its ref (e.g. e12) or CSS selector.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Element ref or CSS selector.' },
      },
      required: ['target'],
    },
  },
  {
    type: 'function',
    name: 'browser_hover',
    description: 'Hover over an element.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string' },
      },
      required: ['target'],
    },
  },
  {
    type: 'function',
    name: 'browser_type',
    description: 'Type text into an element (appends).',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['target', 'text'],
    },
  },
  {
    type: 'function',
    name: 'browser_fill',
    description: 'Clear and fill an input with a value.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        value: { type: 'string' },
      },
      required: ['target', 'value'],
    },
  },
  {
    type: 'function',
    name: 'browser_select_option',
    description: 'Select an option in a <select> element.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        value: { type: 'string' },
      },
      required: ['target', 'value'],
    },
  },
  {
    type: 'function',
    name: 'browser_press',
    description: 'Press a keyboard key (e.g. Enter, Tab, Escape).',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string' },
      },
      required: ['key'],
    },
  },
  {
    type: 'function',
    name: 'browser_upload_file',
    description: 'Upload file(s) to a file input.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        paths: { type: 'array', items: { type: 'string' } },
      },
      required: ['target', 'paths'],
    },
  },
  {
    type: 'function',
    name: 'browser_drag',
    description: 'Drag from one element to another.',
    parameters: {
      type: 'object',
      properties: {
        startTarget: { type: 'string' },
        endTarget: { type: 'string' },
      },
      required: ['startTarget', 'endTarget'],
    },
  },
  {
    type: 'function',
    name: 'browser_evaluate',
    description: 'Evaluate a JavaScript expression in the page context.',
    parameters: {
      type: 'object',
      properties: {
        fn: { type: 'string', description: 'JS expression or function body.' },
      },
      required: ['fn'],
    },
  },
  {
    type: 'function',
    name: 'browser_get_text',
    description: 'Get the text content of an element.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string' },
      },
      required: ['target'],
    },
  },
  {
    type: 'function',
    name: 'browser_get_page_info',
    description: 'Get URL, title, and a short visible-text preview of the current page.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'browser_screenshot',
    description: 'Take a screenshot of the current page.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'browser_tabs',
    description: 'List open browser tabs.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'browser_new_tab',
    description: 'Open a new tab, optionally at a URL.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
      },
    },
  },
  {
    type: 'function',
    name: 'browser_close_tab',
    description: 'Close a tab by index.',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'number' },
      },
    },
  },
  {
    type: 'function',
    name: 'browser_wait_for',
    description: 'Wait for an element to appear.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string' },
      },
      required: ['target'],
    },
  },
  {
    type: 'function',
    name: 'browser_wait_for_text',
    description: 'Wait for text to appear on the page.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' },
      },
      required: ['text'],
    },
  },
  {
    type: 'function',
    name: 'browser_wait_ms',
    description: 'Wait a fixed number of milliseconds.',
    parameters: {
      type: 'object',
      properties: {
        ms: { type: 'number' },
      },
      required: ['ms'],
    },
  },
  {
    type: 'function',
    name: 'request_human_approval',
    description: 'Pause and request human approval before a sensitive action.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string' },
      },
    },
  },
  {
    type: 'function',
    name: 'task_complete',
    description: 'Mark the goal as successfully completed.',
    parameters: {
      type: 'object',
      properties: {
        result: { type: 'string', description: 'Short summary of the outcome.' },
      },
    },
  },
  {
    type: 'function',
    name: 'task_fail',
    description: 'Mark the goal as failed with a clear reason.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string' },
      },
      required: ['reason'],
    },
  },
  {
    type: 'function',
    name: 'generate_website',
    description: 'Generates a speculative real-estate website sample/concept (static HTML/CSS/JS) from structured input. This does NOT publish, deploy, or send the website to anyone — it only creates a local sample the human can review. Do not invent facts (testimonials, awards, stats, property details) that were not provided; use placeholders instead. The returned previewPath is a RELATIVE path for a human to open in the dashboard later — do not call browser_navigate on it or on any guessed hostname for it.',
    parameters: {
      type: 'object',
      properties: {
        prospectName: { type: 'string', description: 'Name of the prospect business.' },
        location: { type: 'string' },
        websiteGoal: { type: 'string' },
        brandStyle: { type: 'string' },
        primaryColor: { type: 'string' },
        secondaryColor: { type: 'string' },
        sections: { type: 'array', items: { type: 'string' } },
        services: { type: 'array', items: { type: 'string' } },
        propertyListings: { type: 'array', items: { type: 'object' } },
        contactInformation: { type: 'object' },
        callToAction: { type: 'string' },
        businessType: { type: 'string' },
      },
      required: ['prospectName'],
    },
  },
  {
    type: 'function',
    name: 'analyze_prospect_page',
    description: 'Analyzes public page text/HTML for real-estate prospect signals. Does not contact anyone.',
    parameters: {
      type: 'object',
      properties: {
        pageText: { type: 'string' },
        pageUrl: { type: 'string' },
        pageTitle: { type: 'string' },
      },
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
        socialProfiles: { type: 'object' },
        serviceGaps: { type: 'array', items: { type: 'string' } },
        sourceUrl: { type: 'string' },
        notes: { type: 'string' },
        source: { type: 'string' },
      },
      required: ['businessName'],
    },
  },
  {
    type: 'function',
    name: 'analyze_opportunity',
    description: 'Runs deterministic opportunity-intelligence analysis for a saved prospect (by prospectId), scoring genuine service gaps across website, social, visual marketing, video, 3D, lead-generation, and automation. Returns a score, priority, recommended services, and a recommended sample type. Does not save anything — call save_opportunity afterward to persist the result.',
    parameters: {
      type: 'object',
      properties: {
        prospectId: { type: 'string', description: 'ID of a previously saved prospect (from save_prospect).' },
        propertyListingsCount: { type: 'number' },
        hasPromoVideo: { type: 'boolean' },
        has3DVisualization: { type: 'boolean' },
        mobileFriendly: { type: 'boolean' },
      },
      required: ['prospectId'],
    },
  },
  {
    type: 'function',
    name: 'save_opportunity',
    description: 'Saves a validated opportunity-intelligence result (from analyze_opportunity) to SQLite, linked to its prospect. Does not contact anyone, submit anything, or publish anything — it only records the analysis locally for human review. If this is the last step your goal requires, call task_complete immediately after this succeeds — do not keep browsing.',
    parameters: {
      type: 'object',
      properties: {
        prospectId: { type: 'string' },
        score: { type: 'number' },
        priority: { type: 'string' },
        opportunityType: { type: 'string' },
        summary: { type: 'string' },
        identifiedProblems: { type: 'array', items: { type: 'string' } },
        recommendedServices: { type: 'array', items: { type: 'string' } },
        recommendedActions: { type: 'array', items: { type: 'string' } },
        recommendedSampleType: { type: 'string' },
        recommendedSampleReason: { type: 'string' },
        estimatedValue: { type: 'string' },
        confidence: { type: 'number' },
      },
      required: ['prospectId'],
    },
  },
];

export function getProvider() {
  const name = (config.ai?.provider || 'stub').toLowerCase();
  if (name === 'cloudflare') return cloudflareProvider({ config });
  if (name === 'openai' || name === 'openai-compatible') return openaiCompatibleProvider({ config });
  return stubProvider();
}

const SENSITIVE_TOOLS = new Set([
  'browser_type',
  'browser_fill',
  'browser_press',
  'browser_upload_file',
  'request_human_approval',
]);

export function isSensitive(tool, args = {}) {
  if (!config.agent?.humanApprovalRequired) return false;
  if (tool === 'request_human_approval') return true;
  if (tool === 'browser_type' || tool === 'browser_fill') {
    const text = String(args?.text || args?.value || '').toLowerCase();
    if (/password|credit.?card|ssn|cvv|card.?number/.test(text)) return true;
  }
  if (tool === 'browser_upload_file' && (args?.paths || []).length > 0) return true;
  return false;
}

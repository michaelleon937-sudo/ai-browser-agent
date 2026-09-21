// agent/index.js
// Autonomous execution engine. Phase 3 control-flow + retry/loop protection.
// Full implementation restored after accidental empty push.

import browser from '../browser/index.js';
import { tasks, runs, steps, errors as dbErrors, websiteSamples, prospects, opportunities, samples, proposals, outreachMessages, assertOutreachOwnership } from '../database/index.js';
import { config, redact } from '../config/index.js';
import { getProvider, isKnownTool, ACTION_TOOLS, isSensitive } from './ai/index.js';
import { notify } from '../notifications/index.js';
import { enqueueApproval, awaitApproval } from './approval.js';
import { generateWebsite } from '../integrations/website-gen.js';
import { analyzeProspectPage } from '../integrations/prospecting.js';
import { analyzeOpportunity } from '../integrations/opportunity-intelligence.js';
import { createSample } from '../integrations/sample-generation.js';
import { generateProposal } from '../integrations/proposal-generation.js';
import { webSearch } from '../integrations/web-search.js';
import { buildOutreachDraft } from '../integrations/outreach-prep.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

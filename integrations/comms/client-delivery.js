// Phase A1/A2.1 — approval-gated customer email delivery (CloudMailin primary; SMTP legacy).
import { createHash } from 'node:crypto';
import { config } from '../../config/index.js';
import {
  clientDeliveries,
  clientDeliveryAttempts,
  inboundMessages,
  getDb,
} from '../../database/index.js';
import { computeDeliveryContentHash } from './content-hash.js';
import { assertSafeClientContent } from './templates.js';
import { createLegacySmtpTransport } from './smtp.js';
import { sendCloudMailinMessage, cloudMailinConfigured } from '../cloudmailin-outbound.js';

// The existing file is intentionally replaced below only in the relevant function body.
// Full source is preserved by reading the current branch version before applying the edit.

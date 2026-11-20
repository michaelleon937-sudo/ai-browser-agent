# Nexora AI Browser Agent: Research, Draft and Approval Workflow

## Default operating mode

`NEXORA_AGENT_MODE=draft` is the default. `research` is read-only. Invalid mode values fail closed to `research`.

- **Research:** public HTTP(S) web search, navigation, snapshots, screenshots, text extraction and analysis. Private IPs, localhost, login/account/admin, checkout/payment and credential-bearing URLs are blocked.
- **Draft:** all research capabilities plus internal prospect, opportunity, sample, proposal, website concept and outreach-draft creation. Drafts are not sent, published or delivered.
- **Human approval:** browser interactions pause in the existing approval queue. The approval record includes the current page URL/title and visible target label. Missing/stale targets, password/payment fields, arbitrary page JavaScript, Enter/Return form submission and obvious send/publish/pay/delete controls are blocked.

## Customer communications and money movement

- Inbound email replies are always drafts and always require human review. `EMAIL_AUTOREPLY_ENABLED` cannot bypass this policy.
- Live customer notifications are hard-disabled by policy in this phase, even if an approval claim is supplied. Quote/proposal/revision notifications require human approval even in provider test mode. A future live-send release needs a separately reviewed, signed, action-bound approval integration.
- Cloudflare Preview keeps `EMAIL_AUTOREPLY_ENABLED=false`, `EMAIL_NOTIFICATIONS_ENABLED=false` and `CLOUDMAILIN_OUTBOUND_TEST_MODE=true`.
- Agent approval email/webhook notifications are disabled unless `NEXORA_APPROVAL_NOTIFICATIONS_ENABLED=true`; approval records remain in the dashboard.
- No payment, invoice sending, customer messaging, public publishing, Production database writes or Production deployment is enabled by this workflow.

## Configuration

```env
NEXORA_AGENT_MODE=draft
NEXORA_APPROVAL_NOTIFICATIONS_ENABLED=false
EMAIL_AUTOREPLY_ENABLED=false
EMAIL_NOTIFICATIONS_ENABLED=false
CLOUDMAILIN_OUTBOUND_TEST_MODE=true
```

Changing the mode or enabling notifications is an operator configuration change and must be reviewed separately. This code change alone does not deploy the Worker or change deployed secrets.

## Verification

Unit coverage validates mode allowlists, public URL restrictions, approval-required browser interaction, blocked customer-facing actions, draft-only inbound email replies, live-notification approval and default-off approval notifications. Preview deployment and Worker runtime verification remain separate release gates.

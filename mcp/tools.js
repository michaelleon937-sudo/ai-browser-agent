// mcp/tools.js
// Public Remote MCP tool definitions. Every entry maps 1:1 to an existing
// Control Layer tool. Keep this list deny-by-default and free of direct
// production-write or communication capabilities.

const objectSchema = (properties = {}, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const stringProperty = (description) => ({
  type: 'string',
  description,
});

const booleanProperty = (description) => ({
  type: 'boolean',
  description,
});

const integerProperty = (description) => ({
  type: 'integer',
  description,
});

export const MCP_TOOL_DEFINITIONS = [
  {
    mcpName: 'agent_health_check',
    controlName: 'agent.health_check',
    title: 'Agent Health Check',
    description: 'Check AI Browser Agent health, database, scheduler, process, and latest run status.',
    inputSchema: objectSchema(),
  },
  {
    mcpName: 'agent_create_task',
    controlName: 'agent.create_task',
    title: 'Create Agent Task',
    description: 'Create an AI Browser Agent task with an optional schedule and metadata.',
    inputSchema: objectSchema(
      {
        name: stringProperty('Task name.'),
        goal: stringProperty('Task goal or instruction.'),
        cronExpression: stringProperty('Optional cron schedule expression.'),
        timezone: stringProperty('Optional IANA timezone for the schedule.'),
        metadata: {
          type: 'object',
          description: 'Optional task metadata.',
          additionalProperties: true,
        },
      },
      ['name', 'goal'],
    ),
  },
  {
    mcpName: 'agent_run_task',
    controlName: 'agent.run_task',
    title: 'Run Agent Task',
    description: 'Start an immediate run for an existing task.',
    inputSchema: objectSchema({
      taskId: stringProperty('Existing task ID.'),
    }, ['taskId']),
  },
  {
    mcpName: 'agent_get_task',
    controlName: 'agent.get_task',
    title: 'Get Agent Task',
    description: 'Read an existing task.',
    inputSchema: objectSchema({
      taskId: stringProperty('Existing task ID.'),
    }, ['taskId']),
  },
  {
    mcpName: 'agent_get_run',
    controlName: 'agent.get_run',
    title: 'Get Agent Run',
    description: 'Read an existing agent run.',
    inputSchema: objectSchema({
      runId: stringProperty('Existing run ID.'),
    }, ['runId']),
  },
  {
    mcpName: 'agent_get_logs',
    controlName: 'agent.get_logs',
    title: 'Get Agent Logs',
    description: 'Read steps, errors, and notifications associated with an agent run.',
    inputSchema: objectSchema({
      runId: stringProperty('Existing run ID.'),
    }, ['runId']),
  },
  {
    mcpName: 'agent_retry_run',
    controlName: 'agent.retry_run',
    title: 'Retry Agent Run',
    description: 'Retry a failed agent run through the existing repair policy.',
    inputSchema: objectSchema({
      runId: stringProperty('Existing failed run ID.'),
    }, ['runId']),
  },

  {
    mcpName: 'browser_open',
    controlName: 'browser.open',
    title: 'Browser Open',
    description: 'Open an allowlisted URL in the browser.',
    inputSchema: objectSchema({
      url: stringProperty('URL to open.'),
      waitUntil: stringProperty('Optional browser navigation wait condition.'),
    }, ['url']),
  },
  {
    mcpName: 'browser_inspect',
    controlName: 'browser.inspect',
    title: 'Browser Inspect',
    description: 'Inspect the current browser page snapshot.',
    inputSchema: objectSchema(),
  },
  {
    mcpName: 'browser_screenshot',
    controlName: 'browser.screenshot',
    title: 'Browser Screenshot',
    description: 'Capture a screenshot of the current browser page.',
    inputSchema: objectSchema({
      fullPage: booleanProperty('Capture the full page when true.'),
    }),
  },
  {
    mcpName: 'browser_extract',
    controlName: 'browser.extract',
    title: 'Browser Extract',
    description: 'Extract visible page information from the current browser page.',
    inputSchema: objectSchema(),
  },
  {
    mcpName: 'browser_click',
    controlName: 'browser.click',
    title: 'Browser Click',
    description: 'Click a browser target. Human approval is required by Control policy.',
    inputSchema: objectSchema(
      {
        target: stringProperty('Browser target to click.'),
        approved: booleanProperty('Explicit human approval required by Control policy.'),
      },
      ['target', 'approved'],
    ),
  },
  {
    mcpName: 'browser_type',
    controlName: 'browser.type',
    title: 'Browser Type',
    description: 'Type text into a browser target. Human approval is required by Control policy.',
    inputSchema: objectSchema(
      {
        target: stringProperty('Browser target to type into.'),
        text: stringProperty('Text to type.'),
        approved: booleanProperty('Explicit human approval required by Control policy.'),
      },
      ['target', 'text', 'approved'],
    ),
  },

  {
    mcpName: 'github_inspect_repository',
    controlName: 'github.inspect_repository',
    title: 'GitHub Inspect Repository',
    description: 'Inspect the configured GitHub repository and its branches.',
    inputSchema: objectSchema(),
  },
  {
    mcpName: 'github_read_file',
    controlName: 'github.read_file',
    title: 'GitHub Read File',
    description: 'Read a file from the configured GitHub repository.',
    inputSchema: objectSchema({
      path: stringProperty('Repository-relative file path.'),
      ref: stringProperty('Optional branch, tag, or commit reference.'),
    }, ['path']),
  },
  {
    mcpName: 'github_run_tests',
    controlName: 'github.run_tests',
    title: 'GitHub Run Tests',
    description: 'Dispatch the repository verification workflow.',
    inputSchema: objectSchema({
      ref: stringProperty('Optional branch, tag, or commit reference.'),
    }),
  },
  {
    mcpName: 'github_get_test_results',
    controlName: 'github.get_test_results',
    title: 'GitHub Get Test Results',
    description: 'Read GitHub Actions verification results.',
    inputSchema: objectSchema({
      runId: stringProperty('Optional GitHub Actions run ID.'),
    }),
  },

  {
    mcpName: 'render_get_status',
    controlName: 'render.get_status',
    title: 'Render Get Status',
    description: 'Read Render service status without deploying.',
    inputSchema: objectSchema({
      target: stringProperty('Optional Render target, such as staging or production.'),
      serviceId: stringProperty('Optional Render service ID.'),
    }),
  },
  {
    mcpName: 'render_get_logs',
    controlName: 'render.get_logs',
    title: 'Render Get Logs',
    description: 'Read Render service logs without deploying.',
    inputSchema: objectSchema({
      target: stringProperty('Optional Render target, such as staging or production.'),
      serviceId: stringProperty('Optional Render service ID.'),
      limit: integerProperty('Optional maximum number of log records.'),
    }),
  },
  {
    mcpName: 'render_get_deployments',
    controlName: 'render.get_deployments',
    title: 'Render Get Deployments',
    description: 'Read Render deployment history without deploying.',
    inputSchema: objectSchema({
      target: stringProperty('Optional Render target, such as staging or production.'),
      serviceId: stringProperty('Optional Render service ID.'),
      limit: integerProperty('Optional maximum number of deployments.'),
    }),
  },

  {
    mcpName: 'repair_get',
    controlName: 'repair.get',
    title: 'Repair Get',
    description: 'Read a repair session.',
    inputSchema: objectSchema({
      sessionId: stringProperty('Existing repair session ID.'),
    }, ['sessionId']),
  },
  {
    mcpName: 'repair_start',
    controlName: 'repair.start',
    title: 'Repair Start',
    description: 'Create or reuse a repair session for a task/run.',
    inputSchema: objectSchema({
      taskId: stringProperty('Optional task ID.'),
      initialRunId: stringProperty('Optional initial run ID.'),
      maxAttempts: integerProperty('Optional maximum repair attempts.'),
    }),
  },
  {
    mcpName: 'repair_advance',
    controlName: 'repair.advance',
    title: 'Repair Advance',
    description: 'Advance a repair session while preserving approval gates for modification and deployment.',
    inputSchema: objectSchema({
      sessionId: stringProperty('Existing repair session ID.'),
      runId: stringProperty('Optional run ID to evaluate.'),
      diagnosis: stringProperty('Optional repair diagnosis.'),
      branchName: stringProperty('Optional repair branch name.'),
      approvedModify: booleanProperty('Explicit approval for repository modification.'),
      approvedDeploy: booleanProperty('Explicit approval for deployment.'),
    }, ['sessionId']),
  },
  {
    mcpName: 'outreach_list',
    controlName: 'outreach.list',
    title: 'List Outreach Messages',
    description: 'List outreach drafts and messages (Phase 6). Read-only.',
    inputSchema: objectSchema({
      limit: integerProperty('Maximum number of messages to return.'),
      status: stringProperty('Optional status filter (e.g. READY_FOR_APPROVAL, APPROVED, SENT).'),
      opportunityId: stringProperty('Optional opportunity ID filter.'),
      prospectId: stringProperty('Optional prospect ID filter.'),
    }),
  },
  {
    mcpName: 'outreach_get',
    controlName: 'outreach.get',
    title: 'Get Outreach Message',
    description: 'Get one outreach message with its approvals and send attempts.',
    inputSchema: objectSchema({
      messageId: stringProperty('Outreach message ID.'),
      id: stringProperty('Alias for messageId.'),
    }),
  },
  {
    mcpName: 'outreach_list_pending',
    controlName: 'outreach.list_pending',
    title: 'List Pending Outreach Approvals',
    description: 'List outreach messages in READY_FOR_APPROVAL status.',
    inputSchema: objectSchema({
      limit: integerProperty('Maximum number of messages to return.'),
    }),
  },
  {
    mcpName: 'outreach_approve',
    controlName: 'outreach.approve',
    title: 'Approve Outreach Draft',
    description: 'Approve a READY_FOR_APPROVAL draft. Requires approved=true. Does not send email.',
    inputSchema: objectSchema({
      messageId: stringProperty('Outreach message ID.'),
      id: stringProperty('Alias for messageId.'),
      approved: booleanProperty('Must be true to confirm operator approval.'),
      decidedBy: stringProperty('Optional operator identifier.'),
    }, ['approved']),
  },
  {
    mcpName: 'outreach_deny',
    controlName: 'outreach.deny',
    title: 'Deny Outreach Draft',
    description: 'Reject a READY_FOR_APPROVAL or APPROVED draft. Does not send email.',
    inputSchema: objectSchema({
      messageId: stringProperty('Outreach message ID.'),
      id: stringProperty('Alias for messageId.'),
      decidedBy: stringProperty('Optional operator identifier.'),
    }),
  },
  {
    mcpName: 'outreach_send_approved',
    controlName: 'outreach.send_approved',
    title: 'Send Approved Outreach',
    description: 'Send an APPROVED outreach email. Requires prior approve decision, approved=true, and Idempotency-Key HTTP header. External side effect.',
    inputSchema: objectSchema({
      messageId: stringProperty('Outreach message ID.'),
      id: stringProperty('Alias for messageId.'),
      approved: booleanProperty('Must be true to confirm send authorization.'),
      decidedBy: stringProperty('Optional operator identifier.'),
    }, ['approved']),
  },
];

export default MCP_TOOL_DEFINITIONS;

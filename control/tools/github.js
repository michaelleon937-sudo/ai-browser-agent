// control/tools/github.js
import { config } from '../../config/index.js';

function githubConfig() {
  return config.control.github;
}

function missingCredsError() {
  const err = new Error('GitHub credentials missing. Set GITHUB_TOKEN (repo + workflow scope). Optional: GITHUB_OWNER, GITHUB_REPO');
  err.status = 503;
  err.code = 'GITHUB_NOT_CONFIGURED';
  throw err;
}

async function gh(path, { method = 'GET', body } = {}) {
  const { token, owner, repo } = githubConfig();
  if (!token) missingCredsError();
  const url = path.startsWith('http') ? path : `https://api.github.com/repos/${owner}/${repo}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ai-browser-agent-control',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(data?.message || `GitHub API ${res.status}`);
    err.status = res.status;
    err.details = data;
    throw err;
  }
  return data;
}

export async function inspectRepository() {
  const { token, owner, repo } = githubConfig();
  if (!token) missingCredsError();
  const repoInfo = await gh('');
  const branches = await gh('/branches?per_page=20');
  return {
    ok: true,
    repository: {
      fullName: repoInfo.full_name || `${owner}/${repo}`,
      defaultBranch: repoInfo.default_branch,
      htmlUrl: repoInfo.html_url,
      pushedAt: repoInfo.pushed_at,
    },
    branches: (branches || []).map((b) => ({ name: b.name, sha: b.commit?.sha })),
  };
}

export async function readFile(args = {}) {
  if (!args.path) {
    const err = new Error('path is required');
    err.status = 400;
    throw err;
  }
  const ref = args.ref || args.branch || githubConfig().defaultBranch;
  const data = await gh(`/contents/${encodeURI(args.path)}?ref=${encodeURIComponent(ref)}`);
  let content = data.content;
  if (data.encoding === 'base64' && content) {
    content = Buffer.from(content, 'base64').toString('utf8');
  }
  return { ok: true, path: data.path, sha: data.sha, encoding: 'utf8', content };
}

export async function runTests(args = {}) {
  const ref = args.ref || githubConfig().defaultBranch;
  const data = await gh('/actions/workflows/verify.yml/dispatches', { method: 'POST', body: { ref } });
  return { ok: true, dispatched: true, workflow: 'verify.yml', ref, note: 'Use github.get_test_results to poll the newest Verify workflow run', dispatch: data };
}

export async function getTestResults(args = {}) {
  if (args.runId) {
    const run = await gh(`/actions/runs/${args.runId}`);
    let jobs = [];
    try {
      const jobData = await gh(`/actions/runs/${args.runId}/jobs`);
      jobs = (jobData.jobs || []).map((j) => ({ id: j.id, name: j.name, status: j.status, conclusion: j.conclusion }));
    } catch {}
    return { ok: true, run: { id: run.id, status: run.status, conclusion: run.conclusion, htmlUrl: run.html_url, headBranch: run.head_branch, event: run.event }, jobs };
  }
  const list = await gh('/actions/workflows/verify.yml/runs?per_page=5');
  const runsList = (list.workflow_runs || []).map((r) => ({ id: r.id, status: r.status, conclusion: r.conclusion, htmlUrl: r.html_url, headBranch: r.head_branch, createdAt: r.created_at }));
  return { ok: true, runs: runsList, latest: runsList[0] || null };
}

export async function modifyFile(args = {}) {
  const branch = String(args.branch || '');
  const defaultBranch = githubConfig().defaultBranch;
  if (!branch.startsWith('repair/')) {
    const err = new Error('github.modify_file may only operate on repair/* branches');
    err.status = 403; throw err;
  }
  if (branch === defaultBranch || branch === 'master' || branch === 'main') {
    const err = new Error('direct master/main modification is forbidden');
    err.status = 403; throw err;
  }
  if (!args.approved) {
    const err = new Error('github.modify_file requires approved=true');
    err.status = 403; throw err;
  }
  if (!args.path || args.content == null || !args.message) {
    const err = new Error('path, content, and message are required');
    err.status = 400; throw err;
  }
  if (args.force) {
    const err = new Error('force push is forbidden');
    err.status = 403; throw err;
  }
  if (!githubConfig().token) missingCredsError();
  let sha;
  try {
    const existing = await gh(`/contents/${encodeURI(args.path)}?ref=${encodeURIComponent(branch)}`);
    sha = existing.sha;
  } catch { sha = undefined; }
  const body = { message: args.message, content: Buffer.from(String(args.content), 'utf8').toString('base64'), branch };
  if (sha) body.sha = sha;
  const result = await gh(`/contents/${encodeURI(args.path)}`, { method: 'PUT', body });
  return { ok: true, path: args.path, branch, commitSha: result.commit?.sha, htmlUrl: result.content?.html_url };
}

export const githubTools = {
  'github.inspect_repository': inspectRepository,
  'github.read_file': readFile,
  'github.run_tests': runTests,
  'github.get_test_results': getTestResults,
  'github.modify_file': modifyFile,
};

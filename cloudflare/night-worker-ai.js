const REPOSITORY = "michaelleon937-sudo/nexora-intelligence";
const REF = "refs/heads/feature/nexora-autonomous-night-worker";
const AGENT_REF_PATTERN = /^refs\/heads\/agent\/nexora-night-worker-[A-Za-z0-9_-]{1,64}$/;
const AUDIENCE = "nexora-night-worker";
const ISSUER = "https://token.actions.githubusercontent.com";
const MAX_BODY_BYTES = 256 * 1024;
const MAX_INPUT_CHARS = 160_000;
let jwksCache = null;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function decodePart(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return bytes;
}

function decodeJsonPart(value) {
  return JSON.parse(new TextDecoder().decode(decodePart(value)));
}

export function isAllowedGithubOidcClaims(claims, nowSeconds = Math.floor(Date.now() / 1000)) {
  const audience = Array.isArray(claims?.aud) ? claims.aud : [claims?.aud];
  return claims?.iss === ISSUER
    && audience.includes(AUDIENCE)
    && claims?.repository === REPOSITORY
    && (claims?.ref === REF || AGENT_REF_PATTERN.test(claims?.ref || ""))
    && ["push", "workflow_dispatch"].includes(claims?.event_name)
    && claims?.workflow_ref === `${REPOSITORY}/.github/workflows/ci.yml@${claims?.ref}`
    && typeof claims?.sub === "string"
    && (claims.sub === `repo:${REPOSITORY}:ref:${claims?.ref}`
      || claims.sub === `repo:${REPOSITORY}:environment:phase7-preview`)
    && Number.isFinite(claims?.exp)
    && claims.exp > nowSeconds
    && (!Number.isFinite(claims?.nbf) || claims.nbf <= nowSeconds + 30);
}

async function getJwks() {
  if (jwksCache && jwksCache.expiresAt > Date.now()) return jwksCache.keys;
  const response = await fetch("https://token.actions.githubusercontent.com/.well-known/jwks", {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("github_oidc_jwks_unavailable");
  const payload = await response.json();
  if (!Array.isArray(payload?.keys)) throw new Error("github_oidc_jwks_invalid");
  jwksCache = { keys: payload.keys, expiresAt: Date.now() + 5 * 60 * 1000 };
  return payload.keys;
}

export async function verifyGithubActionsOidc(token) {
  if (typeof token !== "string" || token.length > 12_000) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const header = decodeJsonPart(parts[0]);
    const claims = decodeJsonPart(parts[1]);
    if (header?.alg !== "RS256" || typeof header?.kid !== "string") return false;
    if (!isAllowedGithubOidcClaims(claims)) return false;
    const keys = await getJwks();
    const jwk = keys.find((key) => key.kid === header.kid && key.kty === "RSA" && key.use === "sig");
    if (!jwk) return false;
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      decodePart(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    return false;
  }
}

function systemPrompt(operation) {
  const common = [
    "You are the Nexora Autonomous Night Worker operating only on an isolated GitHub Preview feature branch.",
    "Never propose Production changes, deployments, migrations against live databases, account mutations, payments, customer outreach, credential changes, or secret handling.",
    "Do not invent test results, browser observations, files, APIs, or evidence.",
    "Only propose source changes in the repository allowlist: app/, components/, lib/, tests/, docs/, public/.",
    "Do not modify package manifests, lockfiles, deployment configuration, workflow files, secrets, auth, billing, payments, integrations, database migrations, or tenant/security primitives.",
    "If a task requires any prohibited action or unavailable permission, return requiresApproval=true and explain the exact blocker.",
    "Return one valid JSON object only. No Markdown fences, commentary, or extra text.",
  ];
  if (operation === "plan") {
    return [...common,
      "Plan a single small, independently verifiable task. Choose the smallest useful next step.",
      "JSON schema: {isComplete:boolean, nextStep:string|null, summary:string, requiresApproval:boolean, blockedReason:string|null, browserUrls:string[], filesToInspect:string[]}.",
      "Set isComplete=true only when the task's acceptance criteria are already satisfied by verified repository state; otherwise set false and propose exactly one small next step.",
      "browserUrls must be public HTTPS research URLs only; never include login pages or private endpoints.",
      "filesToInspect must contain repository-relative paths only, from the allowlist, maximum 8.",
    ].join("\n");
  }
  return [...common,
    "Generate a minimal patch for the supplied task. Preserve existing architecture and conventions.",
    "Never output partial files, diffs, shell commands, or instructions; each file entry must contain the complete replacement file content.",
    "JSON schema: {summary:string, files:[{path:string, content:string}]}. Maximum 8 files.",
    "Do not include files outside the allowlist. Do not include package.json, lockfiles, CI workflows, secrets, migrations, auth, billing, payment, integration, or tenant-security paths.",
    "If a safe patch cannot be produced, return {summary:string, files:[]}.",
  ].join("\n");
}

export async function handleNightWorkerAI(request, env) {
  const authorization = request.headers.get("authorization") || "";
  const token = authorization.replace(/^Bearer\s+/i, "");
  if (!token || !(await verifyGithubActionsOidc(token))) {
    return json({ ok: false, error: "github_oidc_rejected" }, 401);
  }
  if (!env.AI || typeof env.AI.run !== "function") {
    return json({ ok: false, error: "preview_ai_binding_missing" }, 503);
  }
  const operation = new URL(request.url).pathname.split("/").at(-1);
  if (operation !== "plan" && operation !== "patch") {
    return json({ ok: false, error: "unsupported_operation" }, 404);
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return json({ ok: false, error: "request_too_large" }, 413);
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)
    || typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > 8000) {
    return json({ ok: false, error: "invalid_task_input" }, 400);
  }
  const serialized = JSON.stringify(body);
  if (serialized.length > MAX_INPUT_CHARS) return json({ ok: false, error: "input_too_large" }, 413);
  const userContent = operation === "plan"
    ? JSON.stringify({ prompt: body.prompt, mode: body.mode, fileTree: body.fileTree })
    : JSON.stringify({ prompt: body.prompt, mode: body.mode, plan: body.plan, files: body.files, research: body.research });
  const model = typeof env.AI_MODEL === "string" && env.AI_MODEL.startsWith("@cf/")
    ? env.AI_MODEL
    : "@cf/zai-org/glm-4.7-flash";
  try {
    const result = await env.AI.run(model, {
      messages: [
        { role: "system", content: systemPrompt(operation) },
        { role: "user", content: userContent },
      ],
      max_tokens: operation === "plan" ? 1024 : 4096,
      temperature: 0.1,
      stream: false,
    });
    const output = result?.choices?.[0]?.message?.content ?? result?.response;
    if (typeof output !== "string" || !output.trim()) {
      return json({ ok: false, error: "ai_empty_response" }, 502);
    }
    return json({ output, model });
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    console.error(JSON.stringify({ event: "night_worker_ai_error", operation, errorName: name }));
    return json({ ok: false, error: "ai_inference_failed" }, 502);
  }
}

#Requires -Version 5.1
<#
.SYNOPSIS
  scripts/one-shot-deploy.ps1
  One-shot deploy helper for Windows PowerShell. Builds the Docker image
  locally and deploys to either Fly.io or Render, depending on -Target.

.EXAMPLE
  ./scripts/one-shot-deploy.ps1 -Target fly
.EXAMPLE
  ./scripts/one-shot-deploy.ps1 -Target render
#>

param(
  [ValidateSet("fly", "render")]
  [string]$Target = "fly",
  [string]$AppName = "ai-browser-agent"
)

$ErrorActionPreference = "Stop"

function Assert-Command($name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    Write-Error "Required command '$name' was not found on PATH. Install it first."
    exit 1
  }
}

Write-Host "==> AI Browser Agent — one-shot deploy ($Target)" -ForegroundColor Cyan

if (-not (Test-Path ".env")) {
  Write-Warning ".env not found. Copy .env.example to .env and fill in secrets before deploying."
}

Assert-Command "docker"
Write-Host "==> Building local Docker image for a quick sanity check..." -ForegroundColor Cyan
docker build -t "$AppName:local" .

switch ($Target) {
  "fly" {
    Assert-Command "flyctl"
    Write-Host "==> Deploying to Fly.io..." -ForegroundColor Cyan
    if (-not (Test-Path "deploy/fly.toml") -and -not (Test-Path "fly.toml")) {
      Write-Error "fly.toml not found (expected at ./fly.toml or ./deploy/fly.toml)"
      exit 1
    }
    $flyConfig = if (Test-Path "fly.toml") { "fly.toml" } else { "deploy/fly.toml" }
    flyctl deploy --config $flyConfig --app $AppName --local-only
  }
  "render" {
    Write-Host "==> Render deploys are triggered via git push or the Render dashboard." -ForegroundColor Yellow
    Write-Host "    Ensure deploy/render.yaml (or render.yaml) is committed, then:" -ForegroundColor Yellow
    Write-Host "      git add -A; git commit -m 'deploy'; git push" -ForegroundColor Yellow
  }
}

Write-Host "==> Running post-deploy check..." -ForegroundColor Cyan
$Url = Read-Host "Enter the deployed base URL to smoke-test (or leave blank to skip)"
if ($Url) {
  bash ./scripts/post-deploy-check.sh $Url
}

Write-Host "==> Done." -ForegroundColor Green

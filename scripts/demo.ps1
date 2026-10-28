# The OpenTeleport demo: five Claude Code agents move into OpenClaw, and one of them comes back
# as a plain agent folder that any AGENTS.md-aware tool can use. Every command is printed before
# it runs. From the repository root, after `npm run build`:
#
#   powershell -ExecutionPolicy Bypass -File scripts/demo.ps1     (Windows PowerShell 5.1)
#   pwsh -File scripts/demo.ps1                                   (PowerShell 7, any system)
#
# Needs Node.js 24+ and `openclaw` on PATH. Everything happens in a new temporary folder: a copy
# of the Claude Code fixture project (with four more agents made from its `reviewer`), a home for
# OpenTeleport and Claude Code, and a throwaway OpenClaw state directory set up with
# `openclaw onboard --non-interactive`. To use a state directory you onboarded yourself, set
# OPENTELEPORT_DEMO_OPENCLAW_STATE_DIR; the five agents are added to it. The 60-second recording
# script is docs/demo.md.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $repo 'dist/cli.js'
$fixtures = Join-Path $repo 'test/fixtures/claude-code'
$agents = @('reviewer', 'planner', 'tester', 'docs-writer', 'release-manager')

function Stop-Demo([string]$Message) {
    [Console]::Error.WriteLine("demo: $Message")
    exit 1
}

if (-not (Test-Path -LiteralPath $cli)) { Stop-Demo 'dist/cli.js is missing: run npm run build first' }
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $node) { Stop-Demo 'node is not on PATH' }
# openclaw.cmd first: the openclaw.ps1 shim npm also installs may be blocked by the execution policy.
$openclaw = Get-Command openclaw.cmd, openclaw -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
if ($null -eq $openclaw) { Stop-Demo 'openclaw is not on PATH: install OpenClaw first' }

# Prints a command the way you would type it (`$Shown` and `$Arguments`), then runs `$Program`
# with `$Hidden` and `$Arguments`.
function Invoke-Shown([string]$Shown, [string]$Program, [string[]]$Hidden, [string[]]$Arguments) {
    $words = @($Arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } })
    Write-Host ''
    Write-Host ('$ ' + ((@($Shown) + $words) -join ' '))
    $all = @($Hidden) + @($Arguments)
    # A native program's stderr is its own output here, not a PowerShell error.
    $ErrorActionPreference = 'Continue'
    & $Program @all
    if ($LASTEXITCODE -ne 0) { throw "$Shown exited with code $LASTEXITCODE" }
}

function Invoke-OpenTeleport { Invoke-Shown 'openteleport' $node.Path @($cli) $args }
function Invoke-OpenClaw { Invoke-Shown 'openclaw' $openclaw.Path @() $args }

# Runs a snippet of JavaScript with node and returns what it printed.
function Invoke-Node([string]$Script) {
    $output = & $node.Path -e $Script
    if ($LASTEXITCODE -ne 0) { throw "node -e failed with code $LASTEXITCODE" }
    return ($output -join '')
}

$demo = Join-Path ([System.IO.Path]::GetTempPath()) ('openteleport-demo-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $demo | Out-Null
# Read before the variables below are cleared.
$givenState = $env:OPENTELEPORT_DEMO_OPENCLAW_STATE_DIR
if ([string]::IsNullOrEmpty($givenState)) {
    $openclawDir = 'openclaw'
    $stateDir = Join-Path $demo 'openclaw'
} else {
    if (-not (Test-Path -LiteralPath (Join-Path $givenState 'openclaw.json'))) {
        Stop-Demo 'OPENTELEPORT_DEMO_OPENCLAW_STATE_DIR has no openclaw.json'
    }
    $openclawDir = (Resolve-Path -LiteralPath $givenState).ProviderPath
    $stateDir = $openclawDir
}

# As in the e2e: no inherited OPENCLAW_* or OPENTELEPORT_* variable (in any case) may lead a
# command to your own installs, and HOME and USERPROFILE point into the demo folder, so nothing
# falls back to your home. OpenTeleport, Claude Code and OpenClaw keep their state there too.
# Every variable changed here is put back as it was when the script ends.
$saved = @{}
function Set-DemoVariable([string]$Name, $Value) {
    if (-not $saved.ContainsKey($Name)) { $saved[$Name] = [Environment]::GetEnvironmentVariable($Name) }
    [Environment]::SetEnvironmentVariable($Name, $Value)
}
$inherited = @(Get-ChildItem Env: | Where-Object { $_.Name -match '^(OPENCLAW_|OPENTELEPORT_)' } |
    ForEach-Object { $_.Name })
foreach ($name in $inherited) { Set-DemoVariable $name $null }
$demoHome = Join-Path $demo 'home'
Set-DemoVariable 'HOME' $demoHome
Set-DemoVariable 'USERPROFILE' $demoHome
Set-DemoVariable 'OPENTELEPORT_HOME' $demoHome
Set-DemoVariable 'CLAUDE_CONFIG_DIR' (Join-Path $demoHome '.claude')
Set-DemoVariable 'OPENCLAW_STATE_DIR' $stateDir
Set-DemoVariable 'OPENCLAW_CONFIG_PATH' (Join-Path $stateDir 'openclaw.json')
Push-Location -LiteralPath $demo
try {
    Write-Host "Setting up the demo in $demo"

    # A Claude Code project with five agents: the fixture's reviewer and four copies of it.
    Copy-Item -LiteralPath (Join-Path $fixtures 'project') -Destination (Join-Path $demo 'project') -Recurse -Force
    $agentDir = Join-Path $demo 'project/.claude/agents'
    Remove-Item -LiteralPath (Join-Path $agentDir 'plain.md')
    $reviewer = [System.IO.File]::ReadAllText((Join-Path $agentDir 'reviewer.md'))
    $copies = [ordered]@{
        'planner'         = 'Breaks a feature request into small steps that can each be reviewed.'
        'tester'          = 'Writes the missing tests for a change and runs the whole suite.'
        'docs-writer'     = 'Keeps the README and the docs in step with the code.'
        'release-manager' = 'Prepares the release notes and walks the release checklist.'
    }
    foreach ($name in $copies.Keys) {
        $text = $reviewer -replace '(?m)^name: reviewer', "name: $name"
        $text = $text -replace '(?m)^description: [^\r\n]*', "description: $($copies[$name])"
        [System.IO.File]::WriteAllText((Join-Path $agentDir "$name.md"), $text)
    }

    # Claude Code keeps a project's memory under its config directory, keyed by the project path.
    # node works out the key from the same working folder as OpenTeleport will.
    $memoryKey = Invoke-Node 'process.stdout.write(require(''path'').resolve(''project'').replace(/[^A-Za-z0-9]/g, ''-''))'
    $projects = Join-Path $env:CLAUDE_CONFIG_DIR "projects/$memoryKey"
    New-Item -ItemType Directory -Path $projects -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $fixtures 'home/.claude/projects/__project__/memory') -Destination $projects -Recurse -Force

    # A throwaway OpenClaw, onboarded without prompts, providers, services or channels. Its
    # Gateway gets a free port, so nothing here reaches a Gateway you already run.
    if ([string]::IsNullOrEmpty($givenState)) {
        $port = Invoke-Node 'const s = require(''net'').createServer(); s.listen(0, ''127.0.0.1'', () => { process.stdout.write(String(s.address().port)); s.close(); })'
        $log = Join-Path $demo 'onboard.log'
        Write-Host "Onboarding a throwaway OpenClaw in $stateDir (log: $log)"
        $onboard = @(
            'onboard', '--non-interactive', '--accept-risk', '--mode', 'local', '--auth-choice', 'skip',
            '--workspace', (Join-Path $stateDir 'workspace'), '--gateway-port', $port,
            '--gateway-bind', 'loopback', '--tailscale', 'off', '--skip-daemon', '--skip-channels',
            '--skip-skills', '--skip-search', '--skip-hooks', '--skip-ui', '--skip-health',
            '--suppress-gateway-token-output'
        )
        $ErrorActionPreference = 'Continue'
        # Piped input leaves onboarding a closed stdin, so it can never wait on a prompt.
        $null | & $openclaw.Path @onboard *> $log
        $code = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        if ($code -ne 0) { Stop-Demo "openclaw onboard failed; see $log" }
        if (-not (Test-Path -LiteralPath $env:OPENCLAW_CONFIG_PATH)) {
            Stop-Demo "openclaw onboard wrote no openclaw.json; see $log"
        }
    }

    # -- The demo -------------------------------------------------------------------------------

    Invoke-OpenTeleport list --from claude-code --source-dir project

    foreach ($agent in $agents) {
        Invoke-OpenTeleport move --from claude-code --source-dir project --to openclaw --target-dir $openclawDir --agent $agent
    }

    Invoke-OpenClaw agents list

    Invoke-OpenTeleport move --from openclaw --source-dir $openclawDir --to folder --target-dir agents/reviewer --agent reviewer

    Write-Host ''
    Write-Host '$ Get-ChildItem agents/reviewer -Name'
    Get-ChildItem -LiteralPath (Join-Path $demo 'agents/reviewer') -Name -Force | Write-Host

    # Report files are named <timestamp>-<agent>.md, so the last in name order is the newest.
    $report = Get-ChildItem -LiteralPath (Join-Path $env:OPENTELEPORT_HOME '.openteleport/reports') -Filter '*.md' |
        Sort-Object Name | Select-Object -Last 1
    if ($null -eq $report) { throw 'the move wrote no report' }
    Write-Host ''
    Write-Host "Move report: $($report.FullName)"
    Write-Host ''
    Write-Host "`$ Get-Content $($report.FullName)"
    Get-Content -LiteralPath $report.FullName | Write-Host

    Write-Host ''
    Write-Host "Done. Everything is in $demo; delete it when you no longer need it."
} finally {
    Pop-Location
    foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name]) }
}

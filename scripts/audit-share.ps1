param()

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

$shareFiles = @(git -c core.quotepath=false -C $projectRoot ls-files --cached --others --exclude-standard)
if ($LASTEXITCODE -ne 0) {
  throw 'Could not read the project file list.'
}

$violations = [System.Collections.Generic.List[string]]::new()
$forbiddenPaths = @(
  '(^|/)(\.env|fill-config\.json|server\.log)$',
  '(^|/)(sessions|ready_uploads|uploaded_files|recordings|test_auto_work|node_modules|backend|browserAuto)(/|$)',
  '(^|/)browserAuto\.rar$'
)

foreach ($relativePath in $shareFiles) {
  $normalized = $relativePath -replace '\\', '/'
  foreach ($pattern in $forbiddenPaths) {
    if ($normalized -match $pattern) {
      $violations.Add("Forbidden share file: $normalized")
      break
    }
  }
}

$sensitiveValues = [System.Collections.Generic.List[object]]::new()
$envPath = Join-Path $projectRoot '.env'
if (Test-Path -LiteralPath $envPath) {
  $sensitiveEnvKeys = @(
    'MIMO_API_KEY', 'MIMO_BASE_URL', 'MIMO_MODEL',
    'BIP_USERNAME', 'BIP_PASSWORD',
    'BANK_ACCOUNT', 'PAYMENT_BANK', 'BUDGET_ITEM',
    'PAYEE_NAME', 'ORG_NAME', 'SCAN_URL',
    'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL'
  )
  foreach ($line in Get-Content -LiteralPath $envPath) {
    if ($line -notmatch '^\s*([^#][^=]*)=(.*)$') { continue }
    $key = $Matches[1].Trim()
    $value = $Matches[2].Trim().Trim('"').Trim("'")
    $minimumLength = if ($key -eq 'PAYEE_NAME') { 2 } else { 4 }
    if ($key -in $sensitiveEnvKeys -and $value.Length -ge $minimumLength) {
      $sensitiveValues.Add([pscustomobject]@{ Source = ".env:$key"; Value = $value })
    }
  }
}

$fillConfigPath = Join-Path $projectRoot 'fill-config.json'
if (Test-Path -LiteralPath $fillConfigPath) {
  try {
    $fillConfig = [IO.File]::ReadAllText($fillConfigPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $sensitiveFillKeys = @('summary', 'paymentBank', 'bankAccount', 'budgetItem')
    foreach ($property in $fillConfig.PSObject.Properties) {
      $value = [string]$property.Value
      if ($property.Name -in $sensitiveFillKeys -and $value.Trim().Length -ge 2) {
        $sensitiveValues.Add([pscustomobject]@{ Source = "fill-config.json:$($property.Name)"; Value = $value.Trim() })
      }
    }
  } catch {
    $violations.Add('Local fill-config.json is invalid JSON, so it cannot be checked.')
  }
}

$textExtensions = @(
  '.bat', '.cjs', '.css', '.env', '.example', '.html', '.js', '.json', '.md',
  '.mjs', '.ps1', '.ts', '.txt', '.yaml', '.yml'
)
foreach ($relativePath in $shareFiles) {
  $fullPath = [IO.Path]::GetFullPath((Join-Path $projectRoot $relativePath))
  if (-not $fullPath.StartsWith($projectRoot, [StringComparison]::OrdinalIgnoreCase)) {
    $violations.Add("File path leaves project root: $relativePath")
    continue
  }
  if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { continue }
  $extension = [IO.Path]::GetExtension($fullPath).ToLowerInvariant()
  if ($extension -notin $textExtensions -and [IO.Path]::GetFileName($fullPath) -ne '.env.example') { continue }

  foreach ($sensitive in $sensitiveValues) {
    $hits = @(Select-String -LiteralPath $fullPath -SimpleMatch -Pattern $sensitive.Value -ErrorAction SilentlyContinue)
    foreach ($hit in $hits) {
      $violations.Add("Local secret found: $relativePath`:$($hit.LineNumber) (source $($sensitive.Source))")
    }
  }
}

if ($violations.Count) {
  $violations | Sort-Object -Unique | ForEach-Object { Write-Host "[BLOCK] $_" -ForegroundColor Red }
  Write-Host 'Share audit failed. Secret values were not printed.' -ForegroundColor Red
  exit 1
}

Write-Host "Share audit passed for $($shareFiles.Count) candidate files." -ForegroundColor Green

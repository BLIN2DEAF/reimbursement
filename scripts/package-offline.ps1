param(
  [string]$OutputPath = (Join-Path (Join-Path $PSScriptRoot '..\release') 'reimbursement-app-offline-windows-x64.zip')
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

& (Join-Path $PSScriptRoot 'audit-share.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$nodeCommand = Get-Command node.exe -ErrorAction Stop
$nodePath = [IO.Path]::GetFullPath($nodeCommand.Source)
$nodeVersion = (& $nodePath --version).Trim()
if ($nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 20) {
  throw "Node.js 20 or newer is required to build the offline package. Found: $nodeVersion"
}

$nodeModules = Join-Path $projectRoot 'node_modules'
$tsxCli = Join-Path $nodeModules 'tsx\dist\cli.mjs'
$playwrightPackage = Join-Path $nodeModules 'playwright\package.json'
$browserManifest = Join-Path $nodeModules 'playwright-core\browsers.json'
foreach ($requiredPath in @($tsxCli, $playwrightPackage, $browserManifest)) {
  if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
    throw "Missing runtime dependency: $requiredPath. Run npm install first."
  }
}

$playwrightVersion = (Get-Content -LiteralPath $playwrightPackage -Raw | ConvertFrom-Json).version
$browserData = Get-Content -LiteralPath $browserManifest -Raw | ConvertFrom-Json
$chromiumRevision = ($browserData.browsers | Where-Object { $_.name -eq 'chromium' }).revision
$ffmpegRevision = ($browserData.browsers | Where-Object { $_.name -eq 'ffmpeg' }).revision
$browserCache = Join-Path $env:LOCALAPPDATA 'ms-playwright'
$chromiumSource = Join-Path $browserCache "chromium-$chromiumRevision"
$ffmpegSource = Join-Path $browserCache "ffmpeg-$ffmpegRevision"
foreach ($requiredPath in @($chromiumSource, $ffmpegSource)) {
  if (-not (Test-Path -LiteralPath $requiredPath -PathType Container)) {
    throw "Missing Playwright browser: $requiredPath. Run npx playwright install chromium first."
  }
}

$pdftoppm = Get-Command pdftoppm.exe -ErrorAction Stop
$popplerBin = Split-Path -Parent $pdftoppm.Source
$popplerLibrary = [IO.Path]::GetFullPath((Split-Path -Parent $popplerBin))
if (-not (Test-Path -LiteralPath (Join-Path $popplerLibrary 'bin\pdftoppm.exe') -PathType Leaf)) {
  throw "Invalid Poppler runtime: $popplerLibrary"
}

$outputFullPath = [IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $outputFullPath
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("reimbursement-offline-" + [guid]::NewGuid().ToString('N'))
$stagingRoot = Join-Path $temporaryRoot 'reimbursement-app-offline'
New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null

try {
  Write-Host 'Copying application files...'
  $shareFiles = @(git -c core.quotepath=false -C $projectRoot ls-files --cached --others --exclude-standard)
  if ($LASTEXITCODE -ne 0) { throw 'Could not read the project file list.' }
  foreach ($relativePath in $shareFiles) {
    $source = [IO.Path]::GetFullPath((Join-Path $projectRoot $relativePath))
    if (-not $source.StartsWith($projectRoot, [StringComparison]::OrdinalIgnoreCase)) {
      throw "File path leaves project root: $relativePath"
    }
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
    $destination = Join-Path $stagingRoot $relativePath
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination
  }

  # cmd.exe can misparse LF-only batch files and drop the first characters of
  # each line. Normalize every packaged launcher to Windows CRLF explicitly.
  foreach ($batchFile in Get-ChildItem -LiteralPath $stagingRoot -Recurse -File -Filter '*.bat') {
    $batchText = [IO.File]::ReadAllText($batchFile.FullName)
    $batchText = ($batchText -replace "`r?`n", "`r`n")
    [IO.File]::WriteAllText($batchFile.FullName, $batchText, [Text.Encoding]::ASCII)
  }
  $setupScript = Join-Path $stagingRoot 'scripts\configure-offline.ps1'
  if (Test-Path -LiteralPath $setupScript -PathType Leaf) {
    $setupText = [IO.File]::ReadAllText($setupScript) -replace "`r?`n", "`r`n"
    [IO.File]::WriteAllText($setupScript, $setupText, (New-Object Text.UTF8Encoding($true)))
  }

  Write-Host 'Copying Node.js dependencies...'
  Copy-Item -LiteralPath $nodeModules -Destination (Join-Path $stagingRoot 'node_modules') -Recurse

  $runtimeRoot = Join-Path $stagingRoot 'runtime'
  $nodeRuntime = Join-Path $runtimeRoot 'node'
  $browserRuntime = Join-Path $runtimeRoot 'ms-playwright'
  $popplerRuntime = Join-Path $runtimeRoot 'poppler\Library'
  New-Item -ItemType Directory -Force -Path $nodeRuntime, $browserRuntime, $popplerRuntime | Out-Null

  Write-Host "Copying Node.js $nodeVersion..."
  Copy-Item -LiteralPath $nodePath -Destination (Join-Path $nodeRuntime 'node.exe')

  Write-Host "Copying Playwright Chromium for Playwright $playwrightVersion..."
  Copy-Item -LiteralPath $chromiumSource -Destination (Join-Path $browserRuntime (Split-Path -Leaf $chromiumSource)) -Recurse
  Copy-Item -LiteralPath $ffmpegSource -Destination (Join-Path $browserRuntime (Split-Path -Leaf $ffmpegSource)) -Recurse

  Write-Host 'Copying Poppler...'
  Copy-Item -Path (Join-Path $popplerLibrary '*') -Destination $popplerRuntime -Recurse

  $manifest = @(
    'Reimbursement Automation Offline Runtime'
    "Built: $([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss'))"
    "Node.js: $nodeVersion"
    "Playwright: $playwrightVersion"
    "Chromium revision: $chromiumRevision"
    "FFmpeg revision: $ffmpegRevision"
    'Platform: Windows x64'
    ''
    'This package includes runtime components so the receiving computer does not need to install them.'
    'Business use still requires network access to the configured model API and BIP system.'
  ) -join "`r`n"
  [IO.File]::WriteAllText((Join-Path $stagingRoot 'OFFLINE-RUNTIME.txt'), $manifest + "`r`n", $utf8)

  if (Test-Path -LiteralPath $outputFullPath) {
    Remove-Item -LiteralPath $outputFullPath -Force
  }
  Write-Host 'Compressing the offline package. This can take several minutes...'
  Compress-Archive -Path (Join-Path $stagingRoot '*') -DestinationPath $outputFullPath -CompressionLevel Optimal

  $zipInfo = Get-Item -LiteralPath $outputFullPath
  Write-Host ("Offline package created: {0} ({1:N1} MB)" -f $zipInfo.FullName, ($zipInfo.Length / 1MB)) -ForegroundColor Green
} finally {
  $resolvedTemporary = [IO.Path]::GetFullPath($temporaryRoot)
  $resolvedSystemTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if ($resolvedTemporary.StartsWith($resolvedSystemTemp, [StringComparison]::OrdinalIgnoreCase) -and
      (Test-Path -LiteralPath $resolvedTemporary)) {
    Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force
  }
}

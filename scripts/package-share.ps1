param(
  [string]$OutputPath = (Join-Path (Join-Path $PSScriptRoot '..\release') 'reimbursement-app-share.zip')
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$auditScript = Join-Path $PSScriptRoot 'audit-share.ps1'
& $auditScript
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$outputFullPath = [IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $outputFullPath
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

$stagingRoot = Join-Path ([IO.Path]::GetTempPath()) ("reimbursement-share-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stagingRoot | Out-Null

try {
  $shareFiles = @(git -c core.quotepath=false -C $projectRoot ls-files --cached --others --exclude-standard)
  if ($LASTEXITCODE -ne 0) { throw 'Could not read the project file list.' }
  foreach ($relativePath in $shareFiles) {
    $source = [IO.Path]::GetFullPath((Join-Path $projectRoot $relativePath))
    if (-not $source.StartsWith($projectRoot, [StringComparison]::OrdinalIgnoreCase)) {
      throw "File path leaves project root: $relativePath"
    }
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
    $destination = Join-Path $stagingRoot $relativePath
    $destinationDirectory = Split-Path -Parent $destination
    New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination
  }
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
  if (Test-Path -LiteralPath $outputFullPath) {
    Remove-Item -LiteralPath $outputFullPath -Force
  }
  Compress-Archive -Path (Join-Path $stagingRoot '*') -DestinationPath $outputFullPath -CompressionLevel Optimal
  Write-Host "Safe share package created: $outputFullPath" -ForegroundColor Green
} finally {
  $resolvedStaging = [IO.Path]::GetFullPath($stagingRoot)
  $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if ($resolvedStaging.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -and
      (Test-Path -LiteralPath $resolvedStaging)) {
    Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
  }
}

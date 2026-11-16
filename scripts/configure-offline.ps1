param(
  [string]$EnvFile = (Join-Path (Join-Path $PSScriptRoot '..') '.env'),
  [string]$FillConfigFile = (Join-Path (Join-Path $PSScriptRoot '..') 'fill-config.json')
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

function Read-PlainSecret([string]$Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function Read-Required([string]$Prompt, [bool]$Secret = $false) {
  while ($true) {
    $value = if ($Secret) { Read-PlainSecret $Prompt } else { Read-Host $Prompt }
    $value = [string]$value
    if (-not [string]::IsNullOrWhiteSpace($value)) { return $value.Trim() }
    Write-Host '此项为必填内容，请重新输入。' -ForegroundColor Yellow
  }
}

function Read-HttpUrl([string]$Prompt) {
  while ($true) {
    $value = Read-Required $Prompt
    $uri = $null
    if ([Uri]::TryCreate($value, [UriKind]::Absolute, [ref]$uri) -and $uri.Scheme -in @('http', 'https')) {
      return $value.TrimEnd('/')
    }
    Write-Host '请输入以 http:// 或 https:// 开头的完整接口地址。' -ForegroundColor Yellow
  }
}

function Read-Rate([string]$Prompt) {
  while ($true) {
    $value = Read-Required $Prompt
    if ($value -match '^\d+(\.\d+)?$') { return $value }
    Write-Host '这里只能填写数字，例如 100 或 80.5。' -ForegroundColor Yellow
  }
}

function ConvertTo-DotEnvValue([string]$Value) {
  $escaped = $Value.Replace('\', '\\').Replace('"', '\"').Replace("`r", '').Replace("`n", '\n')
  return '"' + $escaped + '"'
}

$envFullPath = [IO.Path]::GetFullPath($EnvFile)
$fillFullPath = [IO.Path]::GetFullPath($FillConfigFile)
if ((Test-Path -LiteralPath $envFullPath) -or (Test-Path -LiteralPath $fillFullPath)) {
  $answer = Read-Host '检测到已有配置。是否重新填写并覆盖？请输入“确认”继续'
  if ($answer -cne '确认' -and $answer -cne 'YES') {
    Write-Host '已取消，原有配置没有被修改。'
    exit 0
  }
}

Write-Host ''
Write-Host '报销自动化系统——首次配置' -ForegroundColor Cyan
Write-Host '请按照信息填写表，依次填写以下 10 项内容。'
Write-Host 'API 密钥、BIP 密码和银行卡号输入时不会显示字符，这是正常的安全保护。'
Write-Host ''

$mimoBaseUrl = Read-HttpUrl '1/10 请输入 MiMo 模型接口地址'
$mimoModel = Read-Required '2/10 请输入 MiMo 模型名称'
$mimoApiKey = Read-Required '3/10 请输入 MiMo API 密钥' $true
$bipUsername = Read-Required '4/10 请输入 BIP 用户名'
$bipPassword = Read-Required '5/10 请输入 BIP 密码' $true
$bankAccount = Read-Required '6/10 请输入收款银行卡号' $true
$paymentBank = Read-Required '7/10 请输入 BIP 页面显示的付款银行名称'
$budgetItem = Read-Required '8/10 请输入 BIP 页面显示的资金预算项目名称'
$mealRate = Read-Rate '9/10 请输入伙食补助标准（元/人/天）'
$transportRate = Read-Rate '10/10 请输入交通补助标准（元/人/天）'

$envLines = @(
  '# 由离线版首次配置程序生成。此文件含有敏感信息，请勿转发。'
  ('MIMO_API_KEY=' + (ConvertTo-DotEnvValue $mimoApiKey))
  ('MIMO_BASE_URL=' + (ConvertTo-DotEnvValue $mimoBaseUrl))
  ('MIMO_MODEL=' + (ConvertTo-DotEnvValue $mimoModel))
  ''
  'HOST=127.0.0.1'
  'PORT=8080'
  'SESSION_TTL_MS=28800000'
  'ERROR_BROWSER_TTL_MS=600000'
  ''
  ('BIP_USERNAME=' + (ConvertTo-DotEnvValue $bipUsername))
  ('BIP_PASSWORD=' + (ConvertTo-DotEnvValue $bipPassword))
  ''
  ('BANK_ACCOUNT=' + (ConvertTo-DotEnvValue $bankAccount))
  ('MEAL_RATE=' + $mealRate)
  ('TRANSPORT_RATE=' + $transportRate)
)
[IO.File]::WriteAllText($envFullPath, ($envLines -join "`r`n") + "`r`n", $utf8)

$fillConfig = [ordered]@{
  paymentBank = $paymentBank
  bankAccount = ''
  budgetItem = $budgetItem
}
$fillJson = $fillConfig | ConvertTo-Json
[IO.File]::WriteAllText($fillFullPath, $fillJson + "`r`n", $utf8)

Write-Host ''
Write-Host '配置保存成功。' -ForegroundColor Green
Write-Host '敏感信息只写入了本机的 .env 和 fill-config.json，请勿转发这两个文件。'
Write-Host '现在可以双击名称以“2-”开头的批处理文件启动系统。'

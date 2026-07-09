# Doc GEMINI_API_KEY tu .env (khong can dan tay key vao dau) va test goi thang toi Gemini REST API.
$envPath = Join-Path $PSScriptRoot "..\.env"
if (-not (Test-Path $envPath)) {
    Write-Output "Khong tim thay file .env tai $envPath"
    exit 1
}

$line = Get-Content $envPath | Where-Object { $_ -match '^GEMINI_API_KEY=' } | Select-Object -First 1
if (-not $line) {
    Write-Output "Khong tim thay dong GEMINI_API_KEY trong .env"
    exit 1
}
$key = ($line -replace '^GEMINI_API_KEY=', '').Trim()
if (-not $key) {
    Write-Output "GEMINI_API_KEY dang rong trong .env"
    exit 1
}

Write-Output "Do dai key: $($key.Length) ky tu | bat dau bang: $($key.Substring(0, [Math]::Min(6, $key.Length)))..."
Write-Output "(Key Gemini chuan tu AI Studio thuong bat dau bang 'AIzaSy' va dai 39 ky tu)"
Write-Output ""

$body = @{ contents = @(@{ parts = @(@{ text = "Say hi in one word" }) }) } | ConvertTo-Json -Depth 5
$sw = [System.Diagnostics.Stopwatch]::StartNew()
try {
    $res = Invoke-RestMethod -Uri "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=$key" -Method Post -ContentType "application/json" -Body $body -TimeoutSec 30
    $sw.Stop()
    Write-Output "OK, thoi gian: $($sw.Elapsed.TotalSeconds)s"
    $res | ConvertTo-Json -Depth 5
} catch {
    $sw.Stop()
    Write-Output "LOI sau $($sw.Elapsed.TotalSeconds)s"
    try {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        Write-Output $reader.ReadToEnd()
    } catch {
        Write-Output $_.Exception.Message
    }
}

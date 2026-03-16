[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

param(
    [string[]]$Langs = @()
)

$REGISTRY_URL = "https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/db/models.json"
$ALL_LANGS = @("bg","cs","de","es","et","fr","hu","is","it","nl","pl","pt","ro","ru","sk","sl","sq","sr","uk","zh")

if ($Langs.Count -eq 0) {
    $Langs = $ALL_LANGS
}

$modelsDir = Join-Path $PSScriptRoot "..\models"

Write-Host "=== Firefox Translations Model Downloader ===" -ForegroundColor Cyan
Write-Host "Loading model registry..." -ForegroundColor Gray

$registry = Invoke-RestMethod $REGISTRY_URL
$baseUrl = $registry.baseUrl

Write-Host "Registry loaded. Base URL: $baseUrl" -ForegroundColor Gray
Write-Host ""

function Get-BestModel($models) {
    $priority = @("Release","Release Android","Release Desktop","Nightly")

    foreach ($p in $priority) {
        $m = $models | Where-Object { $_.releaseStatus -eq $p } | Select-Object -First 1
        if ($m) {
            return $m
        }
    }

    return $models | Select-Object -First 1
}

function Expand-GzipFile($source, $destination) {
    $inputStream = [System.IO.File]::OpenRead($source)
    $outputStream = [System.IO.File]::Create($destination)

    try {
        $gzip = [System.IO.Compression.GZipStream]::new(
            $inputStream,
            [System.IO.Compression.CompressionMode]::Decompress
        )

        try {
            $gzip.CopyTo($outputStream)
        }
        finally {
            $gzip.Dispose()
        }
    }
    finally {
        $outputStream.Dispose()
        $inputStream.Dispose()
    }
}

function Download-Pair($src, $tgt) {
    $key = "$src-$tgt"
    $pair = "$src$tgt"
    $dir = Join-Path $modelsDir $pair

    $models = $registry.models.$key

    if (-not $models) {
        Write-Host "  [!] No model found for $key" -ForegroundColor DarkYellow
        return
    }

    $model = Get-BestModel $models
    $files = $model.files

    New-Item -ItemType Directory -Force -Path $dir | Out-Null

    $fileMap = @{
        "model" = "model.$pair.intgemm.alphas.bin"
        "lexicalShortlist" = "lex.50.50.$pair.s2t.bin"
        "vocab" = "vocab.$pair.spm"
    }

    foreach ($fileKey in $fileMap.Keys) {
        $fileInfo = $files.$fileKey

        if (-not $fileInfo) {
            continue
        }

        $destName = $fileMap[$fileKey]
        $destPath = Join-Path $dir $destName

        if (Test-Path $destPath) {
            Write-Host "  [skip] $pair/$destName" -ForegroundColor DarkGray
            continue
        }

        $remotePath = $fileInfo.path
        $url = "$baseUrl/$remotePath"
        $isGzip = $remotePath.EndsWith(".gz")
        $tempPath = if ($isGzip) { "$destPath.gz" } else { $destPath }

        try {
    Write-Host "  [DOWN] $pair/$destName ..." -NoNewline

    Invoke-WebRequest -Uri $url -OutFile $tempPath -ErrorAction Stop

    if ($isGzip) {
        Expand-GzipFile $tempPath $destPath
        Remove-Item $tempPath -Force
    }

    $sizeMB = [math]::Round((Get-Item $destPath).Length / 1MB, 1)
    Write-Host " $sizeMB MB OK" -ForegroundColor Green
}
catch {
    Write-Host " FAILED: $($_.Exception.Message)" -ForegroundColor Red

    if (Test-Path $tempPath) {
        Remove-Item $tempPath -Force -ErrorAction SilentlyContinue
    }

    if (Test-Path $destPath) {
        Remove-Item $destPath -Force -ErrorAction SilentlyContinue
    }
}
    }
}

Write-Host "Languages: $($Langs -join ', ')" -ForegroundColor Cyan
Write-Host ""

foreach ($lang in $Langs) {
    Write-Host "[en -> $lang]" -ForegroundColor Yellow
    Download-Pair "en" $lang

    Write-Host "[$lang -> en]" -ForegroundColor Yellow
    Download-Pair $lang "en"

    Write-Host ""
}

Write-Host "=== Done! ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Create GitHub Release and upload models:" -ForegroundColor White
Write-Host '  gh release create models-v1 --title "Translation Models v1" --notes "Bergamot models from Mozilla CDN"' -ForegroundColor DarkGray
Write-Host '  Get-ChildItem models -Recurse -File | ForEach-Object { gh release upload models-v1 $_.FullName }' -ForegroundColor DarkGray
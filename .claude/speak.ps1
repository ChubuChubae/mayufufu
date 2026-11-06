param(
    [Parameter(Mandatory, Position = 0)]
    [string]$Text,
    [string]$Voice = 'en-US-EmmaNeural'
)

$outDir = Join-Path $PSScriptRoot 'tts'
New-Item -ItemType Directory -Force $outDir | Out-Null
$mp3 = Join-Path $outDir 'last.mp3'

# Generate speech with edge-tts (free Microsoft Edge neural voices, needs internet)
python -m edge_tts --voice $Voice --text $Text --write-media $mp3 2>$null
if (-not (Test-Path $mp3)) { Write-Error 'Speech generation failed (check internet connection).'; exit 1 }

# Play it without opening any window
Add-Type -AssemblyName PresentationCore
$player = New-Object System.Windows.Media.MediaPlayer
$player.Open([Uri]$mp3)
$waited = 0
while (-not $player.NaturalDuration.HasTimeSpan -and $waited -lt 50) { Start-Sleep -Milliseconds 100; $waited++ }
$player.Play()
if ($player.NaturalDuration.HasTimeSpan) {
    Start-Sleep -Milliseconds ([int]$player.NaturalDuration.TimeSpan.TotalMilliseconds + 300)
} else {
    Start-Sleep -Seconds 5
}
$player.Close()

param([string]$Destination = '.tmp/whisper')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
New-Item -ItemType Directory -Force $Destination | Out-Null
$directory = (Resolve-Path -LiteralPath $Destination).Path
$synth = [System.Speech.Synthesis.SpeechSynthesizer]::new()
try {
  $format = [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $synth.SelectVoice('Microsoft David Desktop')
  $synth.SetOutputToWaveFile((Join-Path $directory 'english.wav'), $format)
  $synth.Speak('Welcome to the local podcast test. The music player keeps all audio on this computer. Today we are testing speech recognition.')
  $synth.SetOutputToNull()
  $synth.SelectVoice('Microsoft Huihui Desktop')
  $synth.SetOutputToWaveFile((Join-Path $directory 'chinese.wav'), $format)
  $synth.Speak('欢迎收听今天的播客。这是中文语音识别测试。所有音频都保留在本机。')
} finally { $synth.Dispose() }
@{source='Windows SpeechSynthesizer';voices=@('Microsoft David Desktop','Microsoft Huihui Desktop');userAudio=$false} | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $directory 'synthetic-fixtures.json')

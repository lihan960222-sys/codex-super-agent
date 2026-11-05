param()
$ErrorActionPreference='Stop'
$assetRoot=Join-Path (Split-Path $PSScriptRoot) 'local\conversation-validation\assets'
New-Item -ItemType Directory -Force -Path $assetRoot | Out-Null
Add-Type -AssemblyName System.Drawing
$bitmap=New-Object System.Drawing.Bitmap 640,320
$graphics=[System.Drawing.Graphics]::FromImage($bitmap)
$font=New-Object System.Drawing.Font 'Arial',28
try {
  foreach($item in @(@{name='image.png';text='BLUE-427'},@{name='image-second.png';text='BLUE-428'})){
    $graphics.Clear([System.Drawing.Color]::White)
    $graphics.DrawRectangle([System.Drawing.Pens]::Blue,30,30,550,200)
    $graphics.DrawString($item.text,$font,[System.Drawing.Brushes]::Blue,80,100)
    $bitmap.Save((Join-Path $assetRoot $item.name))
  }
} finally { $font.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
Add-Type -AssemblyName System.Speech
$voice=New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $chinese=$voice.GetInstalledVoices() | Where-Object {$_.VoiceInfo.Culture.Name -like 'zh-*'} | Select-Object -First 1
  if($chinese){$voice.SelectVoice($chinese.VoiceInfo.Name)}
  $phrases=@{
    'voice.wav'=if($chinese){'暂停铝板任务，钢板继续。'}else{'Pause the aluminum task, continue the steel task.'}
    'voice-create.wav'=if($chinese){'新建铝板试验任务，在产物目录写入记录文件 record.md，内容包含 ALPHA 七三一。'}else{'Create an aluminum test task. Write record dot m d in the output folder, containing ALPHA seven three one.'}
  }
  foreach($name in $phrases.Keys){$voice.SetOutputToWaveFile((Join-Path $assetRoot $name));$voice.Speak($phrases[$name]);$voice.SetOutputToNull()}
} finally {$voice.Dispose()}

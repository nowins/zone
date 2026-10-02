# A restored standard checkpoint can be saved or paused instead of powered off.
function Start-MsixTestVM($VM) {
  $current = Get-VM -Id $VM.Id -ErrorAction Stop
  if ($current.Notes -ne 'Zone MSIX disposable test VM') { throw '虚拟机没有专用测试标记，拒绝启动。' }
  $state = $current.State.ToString()
  if ($state -in @('Off', 'Saved')) { Start-VM -VM $current | Out-Null }
  elseif ($state -eq 'Paused') { Resume-VM -VM $current | Out-Null }
  elseif ($state -ne 'Running') { throw "还原后的虚拟机状态不可运行：$state" }
}

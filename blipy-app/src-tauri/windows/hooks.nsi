; NSIS installer hooks — Windows Firewall rules for StatusForge Blipy
; Blipy broadcasts heartbeats to udp/53735 and listens for Hub discovery
; announcements on udp/53736. Add allow rules on install; remove on uninstall.

!macro NSIS_HOOK_POSTINSTALL
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="StatusForge Blipy" dir=in action=allow program="$INSTDIR\StatusForge Blipy.exe" enable=yes'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="StatusForge Blipy discovery (udp/53736)" dir=in action=allow protocol=UDP localport=53736 program="$INSTDIR\StatusForge Blipy.exe"'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="StatusForge Blipy"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="StatusForge Blipy discovery (udp/53736)"'
!macroend

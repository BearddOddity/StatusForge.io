; NSIS installer hooks — Windows Firewall rules for StatusForge Spark
; SPARK broadcasts heartbeats to udp/53735 and listens for Hub discovery
; announcements on udp/53736. Add allow rules on install; remove on uninstall.

!macro NSIS_HOOK_POSTINSTALL
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="StatusForge Spark" dir=in action=allow program="$INSTDIR\StatusForge Spark.exe" enable=yes'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="StatusForge Spark discovery (udp/53736)" dir=in action=allow protocol=UDP localport=53736 program="$INSTDIR\StatusForge Spark.exe"'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="StatusForge Spark"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="StatusForge Spark discovery (udp/53736)"'
!macroend

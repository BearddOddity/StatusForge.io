; NSIS installer hooks — Windows Firewall rules for StatusForge
; The app binds tcp/53735 (widget/OAuth server, loopback) and
; udp/53735 + udp/53736 (Blipy dual-PC LAN link). Add allow rules on
; install so the OS never blocks the LAN link; remove them on uninstall.

!macro NSIS_HOOK_POSTINSTALL
  ; Clean up rules registered under the pre-1.0 "StatusForge.io" name, in
  ; case this install is an upgrade from a build that used it.
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="StatusForge.io"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="StatusForge.io Blipy heartbeat (udp/53735)"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="StatusForge.io Blipy discovery (udp/53736)"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="StatusForge" dir=in action=allow program="$INSTDIR\StatusForge.exe" enable=yes'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="StatusForge Blipy heartbeat (udp/53735)" dir=in action=allow protocol=UDP localport=53735 program="$INSTDIR\StatusForge.exe"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="StatusForge Blipy discovery (udp/53736)" dir=in action=allow protocol=UDP localport=53736 program="$INSTDIR\StatusForge.exe"'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="StatusForge"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="StatusForge Blipy heartbeat (udp/53735)"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="StatusForge Blipy discovery (udp/53736)"'
!macroend

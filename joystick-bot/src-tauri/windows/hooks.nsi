; NSIS installer hooks — no post-install/pre-uninstall actions needed for
; Joystick Companion. This file exists so the installer script gets
; generated through the same code path as StatusForge and Blipy (both of
; which have real hooks).
;
; The actual NSIS build failure (IsShortcutTarget: "NSISCOMCALL requires 4
; parameter(s), passed 8") was caused by the apostrophe in productName
; ("BearO's Joystick Companion") breaking argument quoting when Tauri
; templated it into that macro call — fixed by dropping the apostrophe from
; productName in tauri.conf.json, not by this file.

!macro NSIS_HOOK_POSTINSTALL
!macroend

!macro NSIS_HOOK_PREUNINSTALL
!macroend

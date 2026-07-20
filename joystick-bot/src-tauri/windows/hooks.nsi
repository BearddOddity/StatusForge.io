; NSIS installer hooks — no post-install/pre-uninstall actions needed for
; Joystick Companion. This file exists only so the installer script gets
; generated through the same code path as StatusForge and Blipy (both of
; which have real hooks); without it, a default-template NSIS build for
; this app hit a macro arity mismatch in IsShortcutTarget
; (NSISCOMCALL expects 4 params, got 8) and failed to compile.

!macro NSIS_HOOK_POSTINSTALL
!macroend

!macro NSIS_HOOK_PREUNINSTALL
!macroend

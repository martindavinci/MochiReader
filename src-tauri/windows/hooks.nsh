; SPDX-License-Identifier: GPL-3.0-or-later
; A PDF lists MochiReader under "Open with" and keeps its own default app: only OpenWithProgids is written, never the
; value of .pdf itself. Markdown and EPUB are associated by Tauri (fileAssociations), which makes the app their default.
; The installer is per user, so SHCTX is HKCU.

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\MochiReader.Pdf" "" "PDF document"
  WriteRegStr SHCTX "Software\Classes\MochiReader.Pdf\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr SHCTX "Software\Classes\MochiReader.Pdf\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  WriteRegStr SHCTX "Software\Classes\.pdf\OpenWithProgids" "MochiReader.Pdf" ""
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue SHCTX "Software\Classes\.pdf\OpenWithProgids" "MochiReader.Pdf"
  DeleteRegKey SHCTX "Software\Classes\MochiReader.Pdf"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

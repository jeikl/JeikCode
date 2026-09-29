!macro NSIS_HOOK_POSTINSTALL
  ; Re-create desktop shortcut explicitly with executable icon index 0
  CreateShortCut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe" 0
  ; Refresh shell icon cache so existing cached placeholders/icons are cleared
  System::Call 'shell32.dll::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

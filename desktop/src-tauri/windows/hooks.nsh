; Define StrStr helper for searching needle ($INSTDIR) in haystack (Path)
!ifndef STRSTR_FUNCTION_DEFINED
!define STRSTR_FUNCTION_DEFINED
Function StrStr
  Exch $R1 ; $R1 = needle
  Exch     ; swap $R1 and haystack
  Exch $R2 ; $R2 = haystack
  Push $R3
  Push $R4
  Push $R5
  StrLen $R3 $R1
  StrCpy $R4 0
loop:
  StrCpy $R5 $R2 $R3 $R4
  StrCmp $R5 $R1 done
  StrCmp $R5 "" done
  IntOp $R4 $R4 + 1
  Goto loop
done:
  StrCpy $R1 $R2 "" $R4
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Exch $R1
FunctionEnd
!endif

!macro KILL_INSTDIR_CHILDREN
  nsExec::Exec 'taskkill /F /IM "jeikcode-desktop.exe" /T'
  ; 仅精确终止从安装目录 $INSTDIR 启动的托管子进程，避免误杀外部终端的 CLI/TUI 会话
  System::Call 'kernel32::SetEnvironmentVariable(t "JEIK_INSTDIR", t "$INSTDIR")'
  nsExec::Exec "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command $\"$$d = [System.IO.Path]::GetFullPath($$env:JEIK_INSTDIR).TrimEnd([char]92); Get-CimInstance Win32_Process | Where-Object { $$_.Name -in @('jeikcode.exe','jeikcode-daemon.exe','cli-bin.exe') -and $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$d, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }$\""
  Sleep 800
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro KILL_INSTDIR_CHILDREN

  ; 清理安装目录下可能被占用或由热更新残留的二进制及备份文件
  IfFileExists "$INSTDIR\resources\jeikcode.exe" 0 +2
    Delete "$INSTDIR\resources\jeikcode.exe"
  IfFileExists "$INSTDIR\resources\jeikcode.exe.bak" 0 +2
    Delete "$INSTDIR\resources\jeikcode.exe.bak"
  IfFileExists "$INSTDIR\resources\.jeikcode.rolling" 0 +2
    Delete "$INSTDIR\resources\.jeikcode.rolling"
  IfFileExists "$INSTDIR\resources\.jeikcode.download" 0 +2
    Delete "$INSTDIR\resources\.jeikcode.download"
  IfFileExists "$INSTDIR\resources\cli-bin" 0 +2
    Delete "$INSTDIR\resources\cli-bin"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Register $INSTDIR and $INSTDIR\resources into user PATH environment variable
  ReadRegStr $0 HKCU "Environment" "Path"
  StrCpy $2 0 ; $2 tracks whether PATH was modified

  ${If} $0 == ""
    WriteRegExpandStr HKCU "Environment" "Path" "$INSTDIR\resources;$INSTDIR"
    StrCpy $2 1
  ${Else}
    ; Append $INSTDIR\resources if not already present
    Push "$0"
    Push "$INSTDIR\resources"
    Call StrStr
    Pop $1
    ${If} $1 == ""
      WriteRegExpandStr HKCU "Environment" "Path" "$INSTDIR\resources;$0"
      ReadRegStr $0 HKCU "Environment" "Path"
      StrCpy $2 1
    ${EndIf}

    ; Append $INSTDIR if not already present
    Push "$0"
    Push "$INSTDIR"
    Call StrStr
    Pop $1
    ${If} $1 == ""
      WriteRegExpandStr HKCU "Environment" "Path" "$INSTDIR;$0"
      StrCpy $2 1
    ${EndIf}
  ${EndIf}

  ; Broadcast WM_SETTINGCHANGE with SMTO_ABORTIFHUNG (0x0002) to skip hung windows immediately
  ; This prevents the installer from blocking 2-3 minutes at "Completed" waiting for hung processes.
  ${If} $2 == 1
    System::Call 'user32::SendMessageTimeoutW(p 0xFFFF, i 0x001A, p 0, w "Environment", i 0x0002, i 1000, *p 0)'
  ${EndIf}

  ; Clean up legacy ~/.local/bin files if left by older dropper versions
  IfFileExists "$PROFILE\.local\bin\jeikcode.exe" 0 +2
    Delete "$PROFILE\.local\bin\jeikcode.exe"
  IfFileExists "$PROFILE\.local\bin\jeikcode.bak.exe" 0 +2
    Delete "$PROFILE\.local\bin\jeikcode.bak.exe"
  IfFileExists "$PROFILE\.local\bin\atomcode.exe" 0 +2
    Delete "$PROFILE\.local\bin\atomcode.exe"
  IfFileExists "$PROFILE\.local\bin\atomcode.bak.exe" 0 +2
    Delete "$PROFILE\.local\bin\atomcode.bak.exe"
  RMDir "$PROFILE\.local\bin"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; 卸载前仅终止安装目录内的托管实例
  !insertmacro KILL_INSTDIR_CHILDREN
!macroend

!macro NSIS_HOOK_UNINSTALL
  ; Clean up desktop shortcut
  Delete "$DESKTOP\${PRODUCTNAME}.lnk"
  ; Refresh shell icon cache
  System::Call 'shell32.dll::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

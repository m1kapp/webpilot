' Webwing 런처 (Windows) — 더블클릭. 콘솔 창 없이 서버 시작 + 브라우저 오픈.
' start.bat 을 숨김(0) 모드로 실행한다.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = here
' 0 = 창 숨김, False = 기다리지 않음
sh.Run """" & here & "\start.bat""", 0, False

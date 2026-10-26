Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
port = "9090"
cfg = dir & "\panel.config.json"
If fso.FileExists(cfg) Then
  Set re = New RegExp
  re.Pattern = """panelPort""\s*:\s*(\d+)"
  txt = fso.OpenTextFile(cfg, 1).ReadAll
  If re.Test(txt) Then port = re.Execute(txt)(0).SubMatches(0)
End If

Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c cd /d """ & dir & """ && node server.js", 0, False
WScript.Sleep 1800
WshShell.Run "http://127.0.0.1:" & port, 1, False

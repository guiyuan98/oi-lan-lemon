@echo off
setlocal
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" echo Cannot find C# compiler.& exit /b 1
if not exist "..\public\downloads" mkdir "..\public\downloads"
"%CSC%" /nologo /target:winexe /optimize+ /out:"..\public\downloads\OI-Proctor-Client.exe" /reference:System.dll /reference:System.Core.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:System.Net.Http.dll /reference:System.Web.Extensions.dll /reference:System.Management.dll ProctorClient.cs
if errorlevel 1 exit /b 1
echo Built: ..\public\downloads\OI-Proctor-Client.exe

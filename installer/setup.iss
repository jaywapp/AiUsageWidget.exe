; AI Usage Widget - Inno Setup script
; CI에서 ISCC /DMyAppVersion=x.y.z 로 빌드

#ifndef MyAppVersion
  #define MyAppVersion "1.0.0"
#endif
#define MyAppName "AI Usage Widget"
#define MyAppExeName "AiUsageWidget.exe"

[Setup]
AppId={{8F4E2D31-7A9B-4C56-9E12-AB34CD56EF78}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=jaywapp
AppPublisherURL=https://github.com/jaywapp/AiUsageWidget.exe
DefaultDirName={autopf}\AiUsageWidget
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=AiUsageWidget-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes
UninstallDisplayIcon={app}\{#MyAppExeName}

[Tasks]
Name: "startup"; Description: "Start automatically with Windows (윈도우 시작 시 자동 실행)"
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Files]
Source: "..\publish\widget\AiUsageWidget.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\server.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\config.json"; DestDir: "{app}"; Flags: onlyifdoesntexist
Source: "..\lib\*"; DestDir: "{app}\lib"; Flags: ignoreversion recursesubdirs
Source: "..\public\*"; DestDir: "{app}\public"; Flags: ignoreversion recursesubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{userstartup}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: startup
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent

[Code]
function InitializeSetup(): Boolean;
var
  R: Integer;
begin
  Result := True;
  // 대시보드 서버 구동에 Node.js 필요 — 없으면 안내만 하고 설치는 계속
  if not Exec(ExpandConstant('{cmd}'), '/c node --version', '', SW_HIDE, ewWaitUntilTerminated, R) or (R <> 0) then
    MsgBox('Node.js 18+ is required for the dashboard server.' + #13#10 +
           'Install it from https://nodejs.org' + #13#10#13#10 +
           '(대시보드 서버 구동에 Node.js 18+가 필요합니다.)', mbInformation, MB_OK);
end;

procedure KillWidget();
var
  R: Integer;
begin
  Exec(ExpandConstant('{cmd}'), '/c taskkill /f /im AiUsageWidget.exe', '', SW_HIDE, ewWaitUntilTerminated, R);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  KillWidget();
  Result := '';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    KillWidget();
end;

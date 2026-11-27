; Inno Setup 6 Script for Starfolio (星海拾卷) Windows x64
#ifndef AppVersion
  #define AppVersion "1.8.0"
#endif

[Setup]
AppId={{8D4F6E2A-4C71-4A1E-9B0D-52F9A3E18C77}
AppName=星海拾卷 (Starfolio)
AppVersion={#AppVersion}
AppVerName=星海拾卷 {#AppVersion}
AppPublisher=Starfolio Open Source
AppPublisherURL=https://github.com/He-Binjie/starfolio
AppSupportURL=https://github.com/He-Binjie/starfolio/issues
DefaultDirName={localappdata}\Programs\Starfolio
DefaultGroupName=星海拾卷
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
DisableProgramGroupPage=yes
SetupIconFile=starfolio.ico
UninstallDisplayIcon={app}\Starfolio.exe
OutputDir=..\dist
OutputBaseFilename=Starfolio-Windows-x64-v1.8-Setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut (在桌面创建「星海拾卷」快捷方式)"; GroupDescription: "Additional icons:"; Flags: checkedonce

[Files]
Source: "..\dist\win-app\Starfolio\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\星海拾卷 (Starfolio)"; Filename: "{app}\Starfolio.exe"; IconFilename: "{app}\Starfolio.exe"
Name: "{group}\Uninstall 星海拾卷"; Filename: "{uninstallexe}"
Name: "{autodesktop}\星海拾卷"; Filename: "{app}\Starfolio.exe"; IconFilename: "{app}\Starfolio.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Starfolio.exe"; Description: "Launch 星海拾卷 (立即启动星海拾卷)"; Flags: nowait postinstall skipifsilent

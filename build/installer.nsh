; The wording and the few special behaviours of the setup wizard and the uninstaller. electron-builder's own NSIS script
; (node_modules/app-builder-lib/templates/nsis) does the work; it calls the macros below at the places it leaves open.
; The names come from brand.js, through defines that build/make-config.js writes: PG_NAME, PG_MAKER, PG_DATA_FOLDER (how the
; program's own folder inside a library is described), PG_SETTINGS_FOLDER, and - for a program that has been renamed - the
; macros pgRemoveFormerShortcuts and pgRemoveFormerSettings and the define PG_FORMER_SETTINGS (the settings folder of an install
; made under the earlier name, which such an install goes on using: see main.js).
;
;   setup, first time     Welcome  >  (Licence, when build/license.txt exists)  >  progress  >  Finish, "Start <name>" ticked
;   setup, as an update   started by the app with  --updated  (no /S): Welcome and Licence are skipped, the progress page
;                         shows, the Finish page is skipped and the program is opened again. Nothing is asked.
;   uninstall             Welcome  >  the settings tick box  >  progress  >  Finish

!ifndef PG_NAME
  !define PG_NAME "${PRODUCT_NAME}"
!endif
!ifndef PG_DATA_FOLDER
  !define PG_DATA_FOLDER "${PRODUCT_NAME}"
!endif
!ifndef PG_SETTINGS_FOLDER
  !define PG_SETTINGS_FOLDER "${PRODUCT_NAME}"
!endif
!ifndef PG_MAKER
  !define PG_MAKER ""
!endif
!ifmacrondef pgRemoveFormerShortcuts
  !macro pgRemoveFormerShortcuts
  !macroend
!endif
!ifmacrondef pgRemoveFormerSettings
  !macro pgRemoveFormerSettings
  !macroend
!endif
!if "${PG_SETTINGS_FOLDER}" == ""
  !error "PG_SETTINGS_FOLDER is empty: the uninstaller's tick box would have nothing safe to remove"
!endif

; ---------- for this Windows user only: the "who is this for" page is never shown and no administrator prompt appears
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; ---------- setup: Welcome
!macro customWelcomePage
  Function pgWelcomeShow
    ; with no licence page, the next thing that happens is the installing itself, so the button says so
    !ifmacrondef licensePage
      GetDlgItem $0 $HWNDPARENT 1
      SendMessage $0 ${WM_SETTEXT} 0 "STR:$(^InstallBtn)"
    !endif
  FunctionEnd
  !insertmacro skipPageIfUpdated
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW pgWelcomeShow
  !define MUI_WELCOMEPAGE_TITLE "Welcome to ${PG_NAME}"
  !define MUI_WELCOMEPAGE_TEXT "This sets up ${PG_NAME} ${VERSION} ${PG_MAKER} for you on this computer. It installs for your Windows account only, so no administrator password is needed.$\r$\n$\r$\n${PG_NAME} shows every 3D model you have, with previews, and helps you bring them together into one tidy library.$\r$\n$\r$\nInstalling changes nothing in your folders. When ${PG_NAME} first starts it asks which folder your 3D print files live in."
  !insertmacro MUI_PAGE_WELCOME
!macroend

; ---------- setup: after the files are in. A program that has been renamed leaves no shortcut behind under its earlier name
; (the main script renames the ones it knows about; this removes any it missed, so there is never a second set).
!macro customInstall
  !insertmacro pgRemoveFormerShortcuts
!macroend

; ---------- setup: the progress page. As an update it says so.
!macro customPageAfterChangeDir
  Function pgInstShow
    ${if} ${isUpdated}
      !insertmacro MUI_HEADER_TEXT "Updating ${PG_NAME}" "Installing version ${VERSION}. ${PG_NAME} will open again by itself."
    ${endIf}
  FunctionEnd
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW pgInstShow
!macroend

; ---------- setup: Finish, with "Start <name>" ticked. As an update the page is not shown: the program is simply opened again.
!macro customFinishPage
  Function pgStartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endIf}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd
  Function pgFinishPre
    ${if} ${isUpdated}
      HideWindow
      Call pgStartApp
      Abort
    ${endIf}
  FunctionEnd
  !define MUI_PAGE_CUSTOMFUNCTION_PRE pgFinishPre
  !define MUI_FINISHPAGE_TITLE "${PG_NAME} is installed"
  !define MUI_FINISHPAGE_TEXT "${PG_NAME} ${VERSION} is ready. You will find it in the Start menu and on your desktop.$\r$\n$\r$\nTo update later, use Help > Check for updates inside the program."
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_TEXT "Start ${PG_NAME}"
  !define MUI_FINISHPAGE_RUN_FUNCTION pgStartApp
  !insertmacro MUI_PAGE_FINISH
!macroend

; ---------- uninstall: Welcome, then one page with the settings tick box (unticked: settings and keys are kept)
!macro customUnWelcomePage
  Var pgRemoveBox
  Var pgRemoveSettings
  !define MUI_WELCOMEPAGE_TITLE "Uninstall ${PG_NAME}"
  !define MUI_WELCOMEPAGE_TEXT "This removes the ${PG_NAME} program from this computer.$\r$\n$\r$\nYour 3D print library is not touched. Your files stay exactly where they are, and so does the program's own folder inside the library (${PG_DATA_FOLDER}), which holds its previews, descriptions and history.$\r$\n$\r$\nClose ${PG_NAME} before you continue."
  !insertmacro MUI_UNPAGE_WELCOME

  Function un.pgSettingsPage
    !insertmacro MUI_HEADER_TEXT "Your settings on this computer" "They are kept unless you tick the box."
    nsDialogs::Create 1018
    Pop $0
    ${NSD_CreateLabel} 0 0 100% 34u "${PG_NAME} keeps a few things for this computer only: which folder is your library, your slicers, paired phones and any AI keys you saved. They are kept, so that installing again carries on where you left off."
    Pop $0
    ${NSD_CreateCheckbox} 0 42u 100% 12u "Also remove my settings and saved AI keys from this computer"
    Pop $pgRemoveBox
    ; an install first made under the program's earlier name keeps its settings in the folder with that name
    StrCpy $1 "${PG_SETTINGS_FOLDER}"
    !ifdef PG_FORMER_SETTINGS
      ${if} ${FileExists} "$APPDATA\${PG_FORMER_SETTINGS}\*.*"
        StrCpy $1 "${PG_FORMER_SETTINGS}"
      ${endIf}
    !endif
    ${NSD_CreateLabel} 12u 58u 96% 30u "Ticking this removes the folder %APPDATA%\$1. It cannot be undone. Your library and the program's folder inside it are not touched either way."
    Pop $0
    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${WM_SETTEXT} 0 "STR:$(^UninstallBtn)"
    nsDialogs::Show
  FunctionEnd
  Function un.pgSettingsLeave
    ${NSD_GetState} $pgRemoveBox $pgRemoveSettings
  FunctionEnd
  UninstPage custom un.pgSettingsPage un.pgSettingsLeave
!macroend

; ---------- uninstall: Finish
!macro customUninstallPage
  !define MUI_FINISHPAGE_TITLE "${PG_NAME} has been removed"
  !define MUI_FINISHPAGE_TEXT "The program has been removed from this computer.$\r$\n$\r$\nYour 3D print library, and the program's folder inside it, were not touched."
!macroend

; ---------- uninstall: what is removed besides the program folder and its shortcuts (those the main script removes).
; Never as part of an update (the old version is uninstalled silently then), and never anything inside a library.
!ifdef APP_INSTALLER_STORE_FILE
  !searchreplace PG_STORE_DIR "${APP_INSTALLER_STORE_FILE}" "\installer.exe" ""
!endif
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; the copy of the setup file that setup keeps for itself
    !ifdef PG_STORE_DIR
      Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
      RMDir "$LOCALAPPDATA\${PG_STORE_DIR}"
    !endif
    ; the per-computer settings, only when the box was ticked (a silent uninstall never ticks it). The one-click kind of
    ; installer has no such page, so it never removes them.
    !ifndef ONE_CLICK
      ${if} $pgRemoveSettings == ${BST_CHECKED}
        RMDir /r "$APPDATA\${PG_SETTINGS_FOLDER}"
        !insertmacro pgRemoveFormerSettings
      ${endIf}
    !endif
  ${endIf}
!macroend

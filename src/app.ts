import { TM_VERSION } from './core/version';
import { bindDomI18n, createI18n, detectLang } from './i18n';
import { StepSound } from './ui/audio';
import { AppController } from './ui/controller';
import { NotificationLog } from './ui/notifications';
import { HelpDialog, Tu4Dialog } from './ui/shell/dialogs';
import { queryAppDom } from './ui/shell/dom';
import { HistoryPanel } from './ui/shell/history-panel';
import { SettingsMenu } from './ui/shell/settings-menu';
import { SettingsStore, ThemeController } from './ui/shell/settings-store';
import { bindShortcuts } from './ui/shell/shortcuts';
import { SidePanels } from './ui/shell/sidepanels';
import { ToolbarView } from './ui/shell/toolbar';
import { loadState, saveProgram, saveTape } from './ui/storage';

export interface MountedApp {
  /** Detach all listeners, timers, observers, and storage subscriptions. */
  dispose(): void;
}

/**
 * Mount the full Turing machine emulator UI onto `doc` and return a handle
 * with a clean `dispose()` lifecycle.
 */
export function mountApp(doc: Document = document): MountedApp {
  const saved = loadState();
  const settings = new SettingsStore(saved.settings);
  const i18n = createI18n(
    detectLang(location.search, settings.get().lang, navigator.languages ?? [navigator.language]),
  );

  const dom = queryAppDom(doc);
  dom.version.textContent = `v${TM_VERSION}`;

  const abortController = new AbortController();
  const { signal } = abortController;

  const theme = new ThemeController({
    root: doc.documentElement,
    themeButtons: dom.themeButtons,
    store: settings,
  });
  const sound = new StepSound(settings.get().sound);

  let toolbar: ToolbarView | null = null;
  let settingsMenu: SettingsMenu | null = null;

  const sidepanels = new SidePanels({
    dom,
    settings,
    onLayoutChange: () => toolbar?.scheduleProgramOverflow(),
    signal,
  });

  const notifications = new NotificationLog({
    element: dom.log,
    i18n,
    onChange: (kind) => sidepanels.handleLogChange(kind),
  });

  const helpDialog = new HelpDialog({
    dom,
    onBeforeOpen: () => settingsMenu?.close(false),
    signal,
  });

  const tu4Dialog = new Tu4Dialog({
    dom,
    i18n,
    onBeforeOpen: () => {
      settingsMenu?.close(false);
      helpDialog.close();
    },
    signal,
  });

  const initialSettings = settings.get();
  const controller = new AppController({
    i18n,
    notifications,
    initialSpeed: initialSettings.speed,
    initialMinSpeed: initialSettings.minSpeed,
    initialMaxSpeed: initialSettings.maxSpeed,
    elements: {
      programInput: dom.programInput,
      tapeInput: dom.tapeInput,
      programView: dom.programView,
      tapeView: dom.tapeView,
      log: dom.log,
      stats: dom.stats,
      controls: dom.controls,
    },
    onModeChange: (mode) => toolbar?.applyMode(mode),
    onRunStateChange: (state) => toolbar?.syncRunState(state),
    onProgramChange: saveProgram,
    onTapeChange: saveTape,
    onTu4Converted: (converted) => tu4Dialog.open(converted),
    onStepSound: () => sound.tick(),
  });

  toolbar = new ToolbarView({
    doc,
    dom,
    i18n,
    controller,
    sound,
    settings,
    onSpeedChanged: () => settingsMenu?.syncSpeedControls(),
    signal,
  });

  const historyPanel = new HistoryPanel({
    dom,
    i18n,
    controller,
    notifications,
    settings,
    onCloseSettings: () => settingsMenu?.close(false),
    onCloseHistoryDrawer: () => sidepanels.setHistoryOpen(false, false),
    onConfirmDeleteSettingChanged: () => settingsMenu?.syncConfirmDeleteControl(),
    signal,
  });

  settingsMenu = new SettingsMenu({
    doc,
    dom,
    i18n,
    controller,
    sound,
    settings,
    theme,
    onToggleConfirmDelete: () => historyPanel.toggleConfirmDelete(),
    isConfirmDeleteEnabled: () => historyPanel.isConfirmDeleteEnabled,
    signal,
  });

  const activeToolbar = toolbar;
  const activeSettingsMenu = settingsMenu;

  bindShortcuts({
    doc,
    dom,
    controller,
    sound,
    isHelpOpen: () => helpDialog.isOpen,
    isBlockingDialogOpen: () => tu4Dialog.isOpen || historyPanel.isDeleteDialogOpen,
    isSettingsOpen: () => activeSettingsMenu.isOpen,
    isHistoryOpen: () => sidepanels.isHistoryOpen,
    isSidepanelOpen: () => sidepanels.isSidepanelOpen,
    openHelp: () => helpDialog.open(),
    closeSettings: (restoreFocus) => activeSettingsMenu.close(restoreFocus),
    closeHistoryDrawer: () => sidepanels.setHistoryOpen(false, false),
    closeSidepanelDrawer: () => sidepanels.setSidepanelOpen(false, false),
    saveSnapshot: () => historyPanel.createManualSnapshot(),
    syncRunToggleLabel: () => activeToolbar.syncRunToggleLabel(),
    signal,
  });

  const syncDynamicI18n = (): void => {
    activeSettingsMenu.syncSoundControl();
    activeSettingsMenu.syncConfirmDeleteControl();
    activeSettingsMenu.syncLangAria();
    helpDialog.render(i18n.help);
    historyPanel.syncLocalized();
    activeToolbar.syncRunToggleLabel();
    activeSettingsMenu.syncSpeedControls();
    activeToolbar.syncHint();
  };

  const unbindDomI18n = bindDomI18n(doc, i18n);
  syncDynamicI18n();
  const unsubscribeI18n = i18n.subscribe(syncDynamicI18n);

  // Hydrate saved draft and initialize toolbar state.
  controller.hydrate(saved.program, saved.tape);
  historyPanel.resetBaseline(dom.programInput.value, dom.tapeInput.value);
  activeToolbar.syncRunState({
    isRunning: false,
    isAutoRunning: false,
    canStepForward: false,
    canStepBack: false,
    canAutoRun: false,
    canRestart: false,
    speed: controller.currentSpeed,
  });

  // Bookmarks landing on `#help` open the in-app help dialog.
  if (location.hash === '#help') helpDialog.open();

  let disposed = false;
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      abortController.abort();
      unsubscribeI18n();
      unbindDomI18n();
      controller.dispose();
      notifications.dispose();
      historyPanel.dispose();
      tu4Dialog.dispose();
      theme.dispose();
    },
  };
}

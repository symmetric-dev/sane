import { useEffect, useId, useState, type ReactNode } from "react";
import { CatalogSelector, CatalogSelectorProvider, useCatalogSelector } from "./catalog-selector";
import { Drawer, Icon, SidebarToggleCommand, viewGroup } from "./nav";
import type { ActiveView } from "./workspace-controller";
import type { WorkspaceSelectionModel } from "./conversation-sidebar-model";
import { NotificationCenter } from "./notification-center";
import { isMacPlatform } from "./application-commands";
import { SIDEBAR_TOGGLE_SHORTCUT, shortcutHint } from "./shortcut-definitions";
import { ChatFlowSidebarDismissContext, useChatFlowSidebarSlot } from "./chat-flow-layout";
import { BROWSER_PAIR_COMPACT_MEDIA } from "./browser-pair";
import { SessionNameDialog } from "./session-name-dialog";

type ShellProps = {
  view: ActiveView;
  sidebar: ReactNode;
  workspaceSidebar?: ReactNode;
  navigation?: ReactNode;
  header: ReactNode;
  beforeHeader?: ReactNode;
  /** Never copied into the navigation drawer: live portals have only one home. */
  desktopSidebar?: ReactNode;
  paired?: boolean;
  resourceSidebar?: boolean;
  notices?: ReactNode;
  children: ReactNode;
  retryCatalog: () => void;
  workspaceSelection?: WorkspaceSelectionModel;
  sidebarOpen: boolean;
  sidebarHidden?: boolean;
  toggleSidebar?: () => void;
  openSidebar: () => void;
  closeSidebar: () => void;
  onOpenNotification?: (id: string) => boolean;
};

/** One sidebar composition for both desktop and the mobile drawer. */
export function ShellSidebar({ children, navigation, onOpenNotification, close }: { children: ReactNode; navigation?: ReactNode; onOpenNotification: (id: string) => boolean; close?: () => void }) {
  const selector = useCatalogSelector();
  const openNotification = (id: string) => { const opened = onOpenNotification(id); if (opened) selector?.close(); return opened; };
  return <>
    <div className="shell-sidebar-header"><NotificationCenter size={28} className="shell-logo" onOpen={openNotification} /><CatalogSelector />{close && <button type="button" className="icon-button" aria-label="Close workspace navigation" onClick={close}><Icon name="close" /></button>}</div>
    <div className="sidebar-body">{children}</div>
    {navigation && <footer className="sidebar-navigation" onClickCapture={() => selector?.close()}>{navigation}</footer>}
  </>;
}

/** Feature providers and their state owners remain above these layout regions. */
export function WorkspaceShell(props: ShellProps) {
  return <CatalogSelectorProvider retry={props.retryCatalog} selection={props.workspaceSelection} onGo={props.closeSidebar}><WorkspaceShellLayout {...props} /></CatalogSelectorProvider>;
}

function WorkspaceShellLayout({ view, sidebar, workspaceSidebar, desktopSidebar, paired = false, resourceSidebar = false, navigation, header, beforeHeader, notices, children, sidebarOpen, sidebarHidden = false, toggleSidebar, openSidebar, closeSidebar, onOpenNotification = () => false }: ShellProps) {
  const selector = useCatalogSelector();
  const selecting = !!selector?.open;
  const group = viewGroup(view);
  const flowSidebar = useChatFlowSidebarSlot();
  const sidebarContent = selecting ? workspaceSidebar ?? sidebar : flowSidebar ? flowSidebar.content : sidebar;
  const sidebarTitle = selecting ? "Worktrees" : resourceSidebar ? view === "browser" ? "Browser tabs" : "Files" : flowSidebar?.title ?? (group === "files" ? "Files" : group === "settings" ? "Settings" : "Conversations");
  const [catalogSidebarHidden, setCatalogSidebarHidden] = useState(false);
  useEffect(() => { if (selecting) setCatalogSidebarHidden(false); }, [selecting]);
  const sidebarId = useId(), drawerId = useId();
  const media = paired && !selecting ? BROWSER_PAIR_COMPACT_MEDIA : "(max-width:700px)";
  const [mobile, setMobile] = useState(() => window.matchMedia(media).matches);
  useEffect(() => {
    const query = window.matchMedia(media);
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [media]);
  useEffect(() => { if (!mobile && sidebarOpen) closeSidebar(); }, [mobile, sidebarOpen, closeSidebar]);
  const hidden = selecting ? catalogSidebarHidden : sidebarHidden;
  const expanded = mobile ? sidebarOpen : !hidden;
  const toggleLabel = mobile ? "Open workspace navigation" : hidden ? "Show sidebar" : "Hide sidebar";
  const toggle = () => {
    if (!selecting) { if (toggleSidebar) toggleSidebar(); else if (sidebarOpen) closeSidebar(); else openSidebar(); return; }
    if (mobile) { if (sidebarOpen) closeSidebar(); else openSidebar(); }
    else {
      if (document.activeElement?.closest(".sidebar")) document.querySelector<HTMLButtonElement>(".sidebar-toggle")?.focus();
      setCatalogSidebarHidden(value => !value);
    }
  };
  return <div className={`app-shell view-${selecting ? "chat" : view} group-${selecting ? "chat" : group}${paired && !selecting ? " browser-pair" : ""}${resourceSidebar && !selecting ? " has-resource-sidebar" : ""}`}>
    <SidebarToggleCommand onToggle={toggle} />
    <SessionNameDialog />
    <aside id={sidebarId} className="sidebar" aria-label={selecting ? "Worktrees" : paired ? "Paired conversation" : flowSidebar?.title ?? "Workspace sidebar"} hidden={hidden} inert={hidden}><ShellSidebar navigation={navigation} onOpenNotification={onOpenNotification}>{selecting ? sidebarContent : desktopSidebar !== undefined ? desktopSidebar : flowSidebar && mobile ? null : sidebarContent}</ShellSidebar></aside>
    <main className="main">
      {!selecting && beforeHeader}
      <header className="topbar"><button type="button" className="icon-button sidebar-toggle" aria-label={toggleLabel} aria-expanded={expanded} aria-controls={mobile ? sidebarOpen ? drawerId : undefined : sidebarId} aria-haspopup={mobile ? "dialog" : undefined} aria-keyshortcuts={`${isMacPlatform() ? "Meta" : "Control"}+b`} title={`${toggleLabel} (${shortcutHint(SIDEBAR_TOGGLE_SHORTCUT)})`} onClick={toggle}><Icon name="menu" /></button><NotificationCenter size={24} className="mobile-shell-logo" onOpen={id => { const opened = onOpenNotification(id); if (opened) selector?.close(); return opened; }} />{selecting ? <div className="conversation-heading">Workspaces</div> : header}</header>
      {!selecting && notices}
      {selector?.page}
      <div className="workspace-active-view" hidden={selecting} inert={selecting}>{children}</div>
    </main>
    {mobile && sidebarOpen && <Drawer id={drawerId} className="workspace-sidebar-drawer" title={sidebarTitle} bare close={closeSidebar}><ShellSidebar navigation={navigation} onOpenNotification={onOpenNotification} close={closeSidebar}><ChatFlowSidebarDismissContext.Provider value={closeSidebar}>{sidebarContent}</ChatFlowSidebarDismissContext.Provider></ShellSidebar></Drawer>}
  </div>;
}

import { useEffect, useId, useState, type ReactNode } from "react";
import { CatalogSelector } from "./catalog-selector";
import { Drawer, Icon, viewGroup } from "./nav";
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
export function ShellSidebar({ children, navigation, retryCatalog, workspaceSelection, onOpenNotification, onGo, close }: { children: ReactNode; navigation?: ReactNode; retryCatalog: () => void; workspaceSelection?: WorkspaceSelectionModel; onOpenNotification: (id: string) => boolean; onGo?: () => void; close?: () => void }) {
  return <>
    <div className="shell-sidebar-header"><NotificationCenter size={28} className="shell-logo" onOpen={onOpenNotification} /><CatalogSelector retry={retryCatalog} selection={workspaceSelection} onGo={onGo} />{close && <button type="button" className="icon-button" aria-label="Close workspace navigation" onClick={close}><Icon name="close" /></button>}</div>
    <div className="sidebar-body">{children}</div>
    {navigation && <footer className="sidebar-navigation">{navigation}</footer>}
  </>;
}

/** Feature providers and their state owners remain above these layout regions. */
export function WorkspaceShell({ view, sidebar, desktopSidebar, paired = false, resourceSidebar = false, navigation, header, beforeHeader, notices, children, retryCatalog, workspaceSelection, sidebarOpen, sidebarHidden = false, toggleSidebar, openSidebar, closeSidebar, onOpenNotification = () => false }: ShellProps) {
  const group = viewGroup(view);
  const flowSidebar = useChatFlowSidebarSlot();
  const sidebarContent = flowSidebar ? flowSidebar.content : sidebar;
  const sidebarTitle = resourceSidebar ? view === "browser" ? "Browser tabs" : "Files" : flowSidebar?.title ?? (group === "files" ? "Files" : group === "settings" ? "Settings" : "Conversations");
  const sidebarId = useId(), drawerId = useId();
  const media = paired ? BROWSER_PAIR_COMPACT_MEDIA : "(max-width:700px)";
  const [mobile, setMobile] = useState(() => window.matchMedia(media).matches);
  useEffect(() => {
    const query = window.matchMedia(media);
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [media]);
  useEffect(() => { if (!mobile && sidebarOpen) closeSidebar(); }, [mobile, sidebarOpen, closeSidebar]);
  const expanded = mobile ? sidebarOpen : !sidebarHidden;
  const toggleLabel = mobile ? "Open workspace navigation" : sidebarHidden ? "Show sidebar" : "Hide sidebar";
  return <div className={`app-shell view-${view} group-${group}${paired ? " browser-pair" : ""}${resourceSidebar ? " has-resource-sidebar" : ""}`}>
    <SessionNameDialog />
    <aside id={sidebarId} className="sidebar" aria-label={paired ? "Paired conversation" : flowSidebar?.title ?? "Workspace sidebar"} hidden={sidebarHidden} inert={sidebarHidden}><ShellSidebar navigation={navigation} retryCatalog={retryCatalog} workspaceSelection={workspaceSelection} onOpenNotification={onOpenNotification} onGo={closeSidebar}>{desktopSidebar !== undefined ? desktopSidebar : flowSidebar && mobile ? null : sidebarContent}</ShellSidebar></aside>
    <main className="main">
      {beforeHeader}
      <header className="topbar"><button type="button" className="icon-button sidebar-toggle" aria-label={toggleLabel} aria-expanded={expanded} aria-controls={mobile ? sidebarOpen ? drawerId : undefined : sidebarId} aria-haspopup={mobile ? "dialog" : undefined} aria-keyshortcuts={`${isMacPlatform() ? "Meta" : "Control"}+b`} title={`${toggleLabel} (${shortcutHint(SIDEBAR_TOGGLE_SHORTCUT)})`} onClick={toggleSidebar ?? (sidebarOpen ? closeSidebar : openSidebar)}><Icon name="menu" /></button><NotificationCenter size={24} className="mobile-shell-logo" onOpen={onOpenNotification} />{header}</header>
      {notices}
      {children}
    </main>
    {mobile && sidebarOpen && <Drawer id={drawerId} className="workspace-sidebar-drawer" title={sidebarTitle} bare close={closeSidebar}><ShellSidebar navigation={navigation} retryCatalog={retryCatalog} workspaceSelection={workspaceSelection} onOpenNotification={onOpenNotification} onGo={closeSidebar} close={closeSidebar}><ChatFlowSidebarDismissContext.Provider value={closeSidebar}>{sidebarContent}</ChatFlowSidebarDismissContext.Provider></ShellSidebar></Drawer>}
  </div>;
}

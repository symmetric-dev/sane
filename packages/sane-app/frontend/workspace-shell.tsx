import type { ReactNode } from "react";
import { CatalogSelector } from "./catalog-selector";
import { Drawer, Icon, viewGroup } from "./nav";
import type { ActiveView } from "./workspace-controller";
import type { WorkspaceSelectionModel } from "./conversation-sidebar-model";
import { NotificationCenter } from "./notification-center";

type ShellProps = {
  view: ActiveView;
  sidebar: ReactNode;
  header: ReactNode;
  notices?: ReactNode;
  children: ReactNode;
  retryCatalog: () => void;
  workspaceSelection?: WorkspaceSelectionModel;
  sidebarOpen: boolean;
  openSidebar: () => void;
  closeSidebar: () => void;
  onOpenNotification?: (id: string) => boolean;
};

/** One sidebar composition for both desktop and the mobile drawer. */
export function ShellSidebar({ children, retryCatalog, workspaceSelection, onOpenNotification, onGo, close }: { children: ReactNode; retryCatalog: () => void; workspaceSelection?: WorkspaceSelectionModel; onOpenNotification: (id: string) => boolean; onGo?: () => void; close?: () => void }) {
  return <>
    <div className="shell-sidebar-header"><NotificationCenter size={28} className="shell-logo" onOpen={onOpenNotification} /><CatalogSelector retry={retryCatalog} selection={workspaceSelection} onGo={onGo} />{close && <button type="button" className="icon-button" aria-label="Close workspace navigation" onClick={close}><Icon name="close" /></button>}</div>
    <div className="sidebar-body">{children}</div>
  </>;
}

/** Feature providers and their state owners remain above these layout regions. */
export function WorkspaceShell({ view, sidebar, header, notices, children, retryCatalog, workspaceSelection, sidebarOpen, openSidebar, closeSidebar, onOpenNotification = () => false }: ShellProps) {
  const group = viewGroup(view);
  return <div className={`app-shell view-${view} group-${group}`}>
    <aside className="sidebar" aria-label="Workspace sidebar"><ShellSidebar retryCatalog={retryCatalog} workspaceSelection={workspaceSelection} onOpenNotification={onOpenNotification} onGo={closeSidebar}>{sidebar}</ShellSidebar></aside>
    <main className="main">
      <header className="topbar"><button type="button" className="icon-button mobile-menu" aria-label="Open workspace navigation" aria-haspopup="dialog" onClick={openSidebar}><Icon name="menu" /></button><NotificationCenter size={24} className="mobile-shell-logo" onOpen={onOpenNotification} />{header}</header>
      {notices}
      {children}
    </main>
    {sidebarOpen && <Drawer title={group === "files" ? "Files" : group === "settings" ? "Settings" : group === "browser" ? "Browser tabs" : "Conversations"} bare close={closeSidebar}><ShellSidebar retryCatalog={retryCatalog} workspaceSelection={workspaceSelection} onOpenNotification={onOpenNotification} onGo={closeSidebar} close={closeSidebar}>{sidebar}</ShellSidebar></Drawer>}
  </div>;
}

import type { ReactNode } from "react";
import { CatalogSelector } from "./catalog-selector";
import { Drawer, Icon, viewGroup } from "./nav";
import type { ActiveView } from "./workspace-controller";
import type { WorkspaceSelectionModel } from "./conversation-sidebar-model";
import { PenroseTriangle } from "./penrose-triangle";

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
};

/** One sidebar composition for both desktop and the mobile drawer. */
export function ShellSidebar({ children, retryCatalog, workspaceSelection }: { children: ReactNode; retryCatalog: () => void; workspaceSelection?: WorkspaceSelectionModel }) {
  return <>
    <div className="shell-sidebar-header"><PenroseTriangle size={28} className="shell-logo" /><CatalogSelector retry={retryCatalog} selection={workspaceSelection} /></div>
    <div className="sidebar-body">{children}</div>
  </>;
}

/** Feature providers and their state owners remain above these layout regions. */
export function WorkspaceShell({ view, sidebar, header, notices, children, retryCatalog, workspaceSelection, sidebarOpen, openSidebar, closeSidebar }: ShellProps) {
  const group = viewGroup(view);
  return <div className={`app-shell view-${view} group-${group}`}>
    <aside className="sidebar" aria-label="Workspace sidebar"><ShellSidebar retryCatalog={retryCatalog} workspaceSelection={workspaceSelection}>{sidebar}</ShellSidebar></aside>
    <main className="main">
      <header className="topbar"><button type="button" className="icon-button mobile-menu" aria-label="Open workspace navigation" aria-haspopup="dialog" onClick={openSidebar}><Icon name="menu" /></button>{header}</header>
      {notices}
      {children}
    </main>
    {sidebarOpen && <Drawer title={group === "files" ? "Files" : group === "settings" ? "Settings" : "Conversations"} close={closeSidebar}><ShellSidebar retryCatalog={retryCatalog} workspaceSelection={workspaceSelection}>{sidebar}</ShellSidebar></Drawer>}
  </div>;
}

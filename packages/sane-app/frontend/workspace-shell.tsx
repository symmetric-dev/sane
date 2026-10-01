import type { ReactNode } from "react";
import { CatalogSelector } from "./catalog-selector";
import { Drawer, Icon, viewGroup } from "./nav";
import type { ActiveView } from "./workspace-controller";

type ShellProps = {
  view: ActiveView;
  sidebar: ReactNode;
  header: ReactNode;
  notices?: ReactNode;
  children: ReactNode;
  retryCatalog: () => void;
  sidebarOpen: boolean;
  openSidebar: () => void;
  closeSidebar: () => void;
};

/** One sidebar composition for both desktop and the mobile drawer. */
export function ShellSidebar({ children, retryCatalog }: { children: ReactNode; retryCatalog: () => void }) {
  return <>
    <div className="shell-sidebar-header"><CatalogSelector retry={retryCatalog} /></div>
    <div className="sidebar-body">{children}</div>
  </>;
}

/** Feature providers and their state owners remain above these layout regions. */
export function WorkspaceShell({ view, sidebar, header, notices, children, retryCatalog, sidebarOpen, openSidebar, closeSidebar }: ShellProps) {
  const group = viewGroup(view);
  return <div className={`app-shell view-${view} group-${group}`}>
    <aside className="sidebar" aria-label="Workspace sidebar"><ShellSidebar retryCatalog={retryCatalog}>{sidebar}</ShellSidebar></aside>
    <main className="main">
      <header className="topbar"><button type="button" className="icon-button mobile-menu" aria-label="Open workspace navigation" aria-haspopup="dialog" onClick={openSidebar}><Icon name="menu" /></button>{header}</header>
      {notices}
      {children}
    </main>
    {sidebarOpen && <Drawer title={group === "files" ? "Files" : group === "settings" ? "Settings" : "Conversations"} close={closeSidebar}><ShellSidebar retryCatalog={retryCatalog}>{sidebar}</ShellSidebar></Drawer>}
  </div>;
}

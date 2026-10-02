import "./theme-settings";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./style.css";
import "./catalog.css";
import "./agents.css";
import "./workers.css";
import "./handoffs.css";
import "./shell.css";

createRoot(document.getElementById("root")!).render(<App />);

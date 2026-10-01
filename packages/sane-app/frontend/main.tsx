import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./style.css";
import "./catalog.css";
import "./agents.css";
import "./workers.css";
import "./shell.css";

createRoot(document.getElementById("root")!).render(<App />);

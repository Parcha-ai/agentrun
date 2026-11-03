import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { followTheme } from "./lib/theme";
import "./styles.css";

// The person's pick of Light or Dark, kept in this browser, before the first render; with none, the OS's, followed as
// it changes.
followTheme();

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

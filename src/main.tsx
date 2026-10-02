import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyMotionTokens } from "./motion/tokens";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import "./styles.css";

applyMotionTokens();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
);

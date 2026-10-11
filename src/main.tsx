import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { StartupShell } from "./components/StartupView";
import { applyMotionTokens } from "./motion/tokens";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import "./styles.css";

applyMotionTokens();

const App = lazy(() => import("./App"));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <Suspense fallback={<StartupShell />}>
        <App />
      </Suspense>
    </AppErrorBoundary>
  </React.StrictMode>,
);

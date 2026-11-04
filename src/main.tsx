import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { migrateLegacySqlLibrary } from "./lib/sqlStore";

// 旧版本把 SQL 历史/收藏放在 localStorage，首次启动搬进本地 SQLite
void migrateLegacySqlLibrary();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

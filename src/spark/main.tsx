import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("spark-root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

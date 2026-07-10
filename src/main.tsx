import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import Launcher from "./Launcher";
import SessionWindow from "./SessionWindow";

const params = new URLSearchParams(window.location.search);
const vid = params.get("vid");

const rootEl = document.getElementById("root")!;
const root = createRoot(rootEl);

root.render(
  <StrictMode>
    {vid ? <SessionWindow /> : <Launcher />}
  </StrictMode>
);

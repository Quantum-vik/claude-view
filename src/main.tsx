import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import Launcher from "./Launcher";
import SessionWindow from "./SessionWindow";
import TerminalWindow from "./TerminalWindow";

const params = new URLSearchParams(window.location.search);
const vid = params.get("vid");
const isTerminal = params.get("kind") === "terminal";

const rootEl = document.getElementById("root")!;
const root = createRoot(rootEl);

root.render(
  <StrictMode>
    {vid ? isTerminal ? <TerminalWindow /> : <SessionWindow /> : <Launcher />}
  </StrictMode>
);

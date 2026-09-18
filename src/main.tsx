import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { initTheme } from "./themes";
import Launcher from "./Launcher";
import SessionWindow from "./SessionWindow";
import TerminalWindow from "./TerminalWindow";
import AgentWindow from "./AgentWindow";

// Apply the persisted theme (CSS vars on :root) before the first render.
initTheme();

const params = new URLSearchParams(window.location.search);
const vid = params.get("vid");
const kind = params.get("kind");
const isTerminal = kind === "terminal";
// An agent run gets its own read-only window: no PTY, so no terminal, no
// resize, nothing to type into.
const isAgent = kind === "agent";

const rootEl = document.getElementById("root")!;
const root = createRoot(rootEl);

root.render(
  <StrictMode>
    {vid ? (
      isAgent ? <AgentWindow /> : isTerminal ? <TerminalWindow /> : <SessionWindow />
    ) : (
      <Launcher />
    )}
  </StrictMode>
);

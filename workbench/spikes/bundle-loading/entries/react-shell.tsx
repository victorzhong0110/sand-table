import { createElement } from "react";
import { createRoot } from "react-dom/client";

const root = document.getElementById("root");
if (root) createRoot(root).render(createElement("p", null, "ok"));

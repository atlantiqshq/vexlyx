import DefaultTheme from "vitepress/theme";

import "./custom.css";

/**
 * The default theme nests a second button (the caret) inside each collapsible sidebar group's
 * button, which fails the "nested-interactive" accessibility rule. The outer element already
 * handles the toggle, so the caret is made purely visual.
 */
function makeSidebarCaretsDecorative() {
  document
    .querySelectorAll<HTMLElement>(".VPSidebarItem .caret[role='button']")
    .forEach((caret) => {
      caret.removeAttribute("role");
      caret.removeAttribute("tabindex");
      caret.setAttribute("aria-hidden", "true");
    });
}

export default {
  extends: DefaultTheme,
  enhanceApp() {
    if (typeof window === "undefined") return;
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        makeSidebarCaretsDecorative();
      });
    }).observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("DOMContentLoaded", makeSidebarCaretsDecorative);
  },
};

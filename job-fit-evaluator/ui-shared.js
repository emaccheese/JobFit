// Small pieces of UI behaviour shared by JobFit's pages and page scripts:
// the score colour bands, screen-reader announcements, and the two-step
// confirm used for anything destructive.
//
// Loaded by the extension's pages and injected with the page scripts, so it
// can't assume a stylesheet: announce() is only used from extension pages,
// which load ui.css (.sr-only). Assigned with var so re-injection doesn't throw.

var JOB_FIT_UI = (function () {
  // One definition of the bands, shared by Tracked jobs, the on-page card and
  // the popup. Also the threshold for "strong match" in Needs attention.
  const GREEN_FROM = 75;
  const AMBER_FROM = 55;

  // Null means summarized but never scored. That has to read as neutral, not
  // as a red 0, which is what a hard reject looks like.
  function scoreClass(score) {
    if (score == null) return "";
    if (score >= GREEN_FROM) return "green";
    if (score >= AMBER_FROM) return "amber";
    return "red";
  }

  // A polite live region, created on first use. Cleared and refilled on a
  // tick so the same message twice in a row is still read out.
  let region = null;
  let regionTimer = null;

  function announce(text) {
    if (typeof document === "undefined" || !document.body) return;
    if (!region || !region.isConnected) {
      region = document.createElement("div");
      region.className = "sr-only";
      region.setAttribute("role", "status");
      region.setAttribute("aria-live", "polite");
      document.body.appendChild(region);
    }
    clearTimeout(regionTimer);
    region.textContent = "";
    regionTimer = setTimeout(() => {
      region.textContent = String(text || "");
    }, 60);
  }

  // Two clicks for anything you can't undo: the first arms the button (red,
  // with the confirm wording, announced), the second within the window acts.
  // Not confirm(): a modal dialog can dismiss an extension popup, and a
  // button that asks in place is quicker. One timeout everywhere, so the
  // pattern behaves the same wherever it appears. Esc or leaving the window
  // idle disarms.
  const CONFIRM_MS = 5000;

  function armConfirm(button, { confirmLabel, onConfirm, onArm, onDisarm, ms = CONFIRM_MS }) {
    let armed = false;
    let idleLabel = "";
    let timer = null;

    function disarm() {
      if (!armed) return;
      armed = false;
      clearTimeout(timer);
      button.textContent = idleLabel;
      button.classList.remove("armed");
      if (onDisarm) onDisarm();
    }

    button.addEventListener("click", async (event) => {
      if (!armed) {
        armed = true;
        idleLabel = button.textContent;
        const label = typeof confirmLabel === "function" ? await confirmLabel() : confirmLabel;
        // The label may have come from an async lookup; bail if it was
        // disarmed meanwhile.
        if (!armed) return;
        button.textContent = label;
        button.classList.add("armed");
        announce(label);
        if (onArm) onArm(label);
        timer = setTimeout(disarm, ms);
        return;
      }
      disarm();
      await onConfirm(event);
    });
    button.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && armed) {
        event.stopPropagation();
        disarm();
      }
    });
    return { disarm, get armed() { return armed; } };
  }

  return { GREEN_FROM, AMBER_FROM, scoreClass, announce, armConfirm, CONFIRM_MS };
})();

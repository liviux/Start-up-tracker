// The app's own confirm and alert (window.StartupTrackerDialog), used in
// place of the browser's. The dialog is an ordinary modal card, so every
// theme styles it like the app's other windows. Both calls return a promise:
//
//   if (await Dialog.confirm(t("..."), { confirmLabel: t("..."), danger: true })) ...
//   await Dialog.alert(t("..."));
//
// One dialog shows at a time; a second call waits until the first closes.
// Escape and the backdrop cancel, and focus goes back where it was.
(function (root) {
  "use strict";

  const t = (key, params) => root.StartupTrackerI18n.t(key, params);
  // Titled with the app's name (Settings > General) unless the caller names it.
  const appName = () => String(root.StartupTrackerSettings?.get?.().appName || "").trim() || t("app.name");
  let queue = Promise.resolve();

  function show({ message, title, confirmLabel, cancelLabel, danger, cancellable }) {
    const doc = root.document;
    const previous = doc.activeElement;
    const overlay = doc.createElement("div");
    overlay.className = "modal-overlay app-dialog";
    overlay.innerHTML = `
      <div class="modal-card app-dialog-card" role="alertdialog" aria-modal="true" aria-labelledby="appDialogTitle" aria-describedby="appDialogMessage">
        <div class="modal-header"><h2 id="appDialogTitle"></h2></div>
        <div class="modal-body"><p class="app-dialog-message" id="appDialogMessage"></p></div>
        <div class="modal-footer">
          ${cancellable ? `<button class="secondary-button" type="button" data-dialog-answer="no"></button>` : ""}
          <button class="${danger ? "danger-button" : "primary-button"}" type="button" data-dialog-answer="yes"></button>
        </div>
      </div>`;
    overlay.querySelector("#appDialogTitle").textContent = title;
    overlay.querySelector("#appDialogMessage").textContent = message;
    overlay.querySelector("[data-dialog-answer=yes]").textContent = confirmLabel;
    const no = overlay.querySelector("[data-dialog-answer=no]");
    if (no) no.textContent = cancelLabel;
    // Visible from the start (it still fades in): a visibility transition
    // would keep the button below from taking the focus.
    overlay.style.visibility = "visible";
    doc.body.append(overlay);
    void overlay.offsetHeight;
    overlay.classList.add("open");
    // The safe answer has the focus, so Enter never deletes by accident.
    (danger && no ? no : overlay.querySelector("[data-dialog-answer=yes]")).focus();

    return new Promise((resolve) => {
      // The dialog answers every key while it is open, wherever the focus is,
      // so nothing behind it sees them: the app's own Escape would hide the
      // dialog without an answer and leave its caller waiting.
      const onKey = (event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
        } else if (event.key === "Tab") {
          const buttons = [...overlay.querySelectorAll("button")];
          const index = buttons.indexOf(doc.activeElement);
          event.preventDefault();
          buttons[(index + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length].focus();
        }
      };
      const finish = (answer) => {
        root.removeEventListener("keydown", onKey, true);
        overlay.remove();
        if (previous && typeof previous.focus === "function" && doc.contains(previous)) previous.focus();
        resolve(answer);
      };
      overlay.addEventListener("click", (event) => {
        const button = event.target.closest("[data-dialog-answer]");
        if (button) finish(button.dataset.dialogAnswer === "yes");
      });
      overlay.addEventListener("mousedown", (event) => {
        if (event.target === overlay) finish(false);
      });
      root.addEventListener("keydown", onKey, true);
    });
  }

  function enqueue(options) {
    const next = queue.then(() => show(options));
    queue = next.catch(() => {});
    return next;
  }

  // Resolves to true when the person confirms.
  function confirm(message, { title = appName(), confirmLabel = t("dialog.ok"), cancelLabel = t("dialog.cancel"), danger = false } = {}) {
    return enqueue({ message: String(message ?? ""), title, confirmLabel, cancelLabel, danger, cancellable: true });
  }

  // Resolves once the message is read.
  function alert(message, { title = appName(), confirmLabel = t("dialog.ok") } = {}) {
    return enqueue({ message: String(message ?? ""), title, confirmLabel, cancellable: false }).then(() => undefined);
  }

  root.StartupTrackerDialog = Object.freeze({ confirm, alert });
})(globalThis);

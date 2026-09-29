// Wires the launch post's social kit copy buttons. The panel is static HTML
// (the CSP allows only same-origin scripts), so each button copies the text
// of the item it sits in.
for (const button of document.querySelectorAll<HTMLButtonElement>(".plain-publication__social-kit-copy")) {
  const text = button.closest(".plain-publication__social-kit-item")?.querySelector(".plain-publication__social-kit-text")?.textContent;
  if (!text) continue;
  const label = button.firstChild;
  button.addEventListener("click", () => {
    navigator.clipboard.writeText(text).then(() => {
      if (label) label.textContent = "Copied";
      setTimeout(() => { if (label) label.textContent = "Copy"; }, 1600);
    }, () => undefined);
  });
}

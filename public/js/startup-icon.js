// A startup's icon: the uploaded image, resized in the browser, or a
// monogram of its initials when it has none. The same picture is used in the
// switcher, in Settings and as the page's favicon.
//
// UMD: browsers get window.StartupTrackerIcon, Node gets module.exports.
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StartupTrackerIcon = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const ICON_SIZE = 256;
  // Slate 600 with white text: 7.6:1, readable on light and dark sidebars.
  const MONOGRAM_BACKGROUND = "#475569";
  const MONOGRAM_TEXT = "#ffffff";
  const ACCEPTED_TYPES = Object.freeze({
    "image/png": "png",
    "image/svg+xml": "svg",
    "image/jpeg": "jpg",
    "image/x-icon": "ico",
    "image/vnd.microsoft.icon": "ico",
  });
  const ACCEPTED_EXTENSIONS = Object.freeze(["png", "svg", "jpg", "jpeg", "ico"]);
  const ACCEPT_ATTRIBUTE = ".png,.svg,.jpg,.jpeg,.ico,image/png,image/svg+xml,image/jpeg,image/x-icon,image/vnd.microsoft.icon";
  const DATA_URL_PATTERN = /^data:(image\/[a-z0-9.+-]+);base64,/i;
  // Uploads larger than this are refused before they are decoded.
  const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

  // Up to two letters: the first letters of the first two words, or the
  // first two letters of a single word. Letters and digits of any script.
  function initials(name) {
    const words = String(name || "")
      .normalize("NFC")
      .split(/[\s\-_.·/]+/u)
      .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
      .filter(Boolean);
    if (!words.length) return "?";
    const letters = words.length === 1
      ? Array.from(words[0]).slice(0, 2)
      : [Array.from(words[0])[0], Array.from(words[1])[0]];
    return letters.join("").toLocaleUpperCase();
  }

  function escapeXml(text) {
    return String(text).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]);
  }

  function monogramSvg(name) {
    const text = initials(name);
    const fontSize = text.length > 1 ? 104 : 132;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_SIZE}" height="${ICON_SIZE}" viewBox="0 0 ${ICON_SIZE} ${ICON_SIZE}">`
      + `<rect width="${ICON_SIZE}" height="${ICON_SIZE}" rx="56" fill="${MONOGRAM_BACKGROUND}"/>`
      + `<text x="50%" y="50%" dy="0.35em" text-anchor="middle" fill="${MONOGRAM_TEXT}" `
      + `font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-weight="700" font-size="${fontSize}">${escapeXml(text)}</text>`
      + "</svg>";
  }

  function toBase64(text) {
    if (typeof root.btoa === "function" && typeof root.TextEncoder === "function") {
      const bytes = new root.TextEncoder().encode(text);
      let binary = "";
      bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
      return root.btoa(binary);
    }
    return root.Buffer.from(text, "utf8").toString("base64");
  }

  function monogramDataUrl(name) {
    return `data:image/svg+xml;base64,${toBase64(monogramSvg(name))}`;
  }

  // The uploaded icon when it is a data URL the server would accept.
  function safeIcon(icon) {
    return typeof icon === "string" && DATA_URL_PATTERN.test(icon) ? icon : "";
  }

  function iconMimeType(icon) {
    const match = DATA_URL_PATTERN.exec(String(icon || ""));
    return match ? match[1].toLowerCase() : "";
  }

  // What the switcher and the favicon show for a startup.
  function iconFor(startup) {
    return safeIcon(startup?.icon) || monogramDataUrl(startup?.name || "");
  }

  function fileExtension(name) {
    const match = /\.([a-z0-9]+)$/i.exec(String(name || ""));
    return match ? match[1].toLowerCase() : "";
  }

  // PNG, SVG, JPG or ICO, by type or, when the browser gives no type (some
  // do for .ico), by extension.
  function isAcceptedIconFile(file) {
    if (!file) return false;
    const type = String(file.type || "").toLowerCase();
    if (type) return Object.prototype.hasOwnProperty.call(ACCEPTED_TYPES, type);
    return ACCEPTED_EXTENSIONS.includes(fileExtension(file.name));
  }

  // The size an image is drawn at to fit a square of `max` pixels without
  // being stretched. Small images are scaled up so the icon fills the square.
  function fitSize(width, height, max = ICON_SIZE) {
    const w = Number(width) || max;
    const h = Number(height) || max;
    const scale = max / Math.max(w, h);
    const drawWidth = Math.max(1, Math.round(w * scale));
    const drawHeight = Math.max(1, Math.round(h * scale));
    return {
      width: drawWidth,
      height: drawHeight,
      x: Math.round((max - drawWidth) / 2),
      y: Math.round((max - drawHeight) / 2),
    };
  }

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new root.FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("Could not read the file."));
      reader.readAsDataURL(file);
    });
  }

  function loadImage(source) {
    return new Promise((resolve, reject) => {
      const image = new root.Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("The image could not be opened."));
      image.src = source;
    });
  }

  // Draws the file on a 256 × 256 transparent canvas and returns a PNG data
  // URL. SVG and ICO files come out as PNG too, so every icon is the same size.
  async function resizeIconFile(file, size = ICON_SIZE) {
    if (!isAcceptedIconFile(file)) {
      const error = new Error("unsupportedType");
      error.code = "unsupportedType";
      throw error;
    }
    if (Number(file.size) > MAX_UPLOAD_BYTES) {
      const error = new Error("tooLarge");
      error.code = "tooLarge";
      throw error;
    }
    const source = await readAsDataUrl(file);
    const image = await loadImage(source);
    const canvas = root.document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    const box = fitSize(image.naturalWidth || image.width, image.naturalHeight || image.height, size);
    context.imageSmoothingQuality = "high";
    context.drawImage(image, box.x, box.y, box.width, box.height);
    return canvas.toDataURL("image/png");
  }

  return Object.freeze({
    ICON_SIZE,
    MONOGRAM_BACKGROUND,
    MONOGRAM_TEXT,
    ACCEPTED_TYPES,
    ACCEPT_ATTRIBUTE,
    MAX_UPLOAD_BYTES,
    initials,
    monogramSvg,
    monogramDataUrl,
    safeIcon,
    iconMimeType,
    iconFor,
    isAcceptedIconFile,
    fitSize,
    resizeIconFile,
  });
});

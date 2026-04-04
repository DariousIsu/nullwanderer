/**
 * AURA NX-Alpha — Canvas Drop Utilities
 *
 * Shared file classification and upload helpers for canvas drag-and-drop.
 * Used by both the main workspace canvas and the portrait mode AuraCanvas.
 */

export const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

/**
 * Returns true for image files — sent as base64 to /canvas/image.
 */
export const isImageFile = (file) => file.type.startsWith('image/');

/**
 * Returns true for any text or document file the model can read.
 * Covers: plain text, markdown, code, CSV, JSON, XML, PDF, Office formats, RTF.
 */
export const isDocumentFile = (file) => {
  if (isImageFile(file)) return false;

  // Explicit MIME types
  if (
    file.type.startsWith('text/')           ||   // text/plain, text/html, text/csv, text/markdown…
    file.type === 'application/pdf'         ||
    file.type === 'application/json'        ||
    file.type === 'application/xml'         ||
    file.type === 'application/rtf'         ||
    file.type === 'application/msword'      ||   // .doc
    file.type.includes('officedocument')    ||   // .docx / .xlsx / .pptx
    file.type.includes('opendocument')      ||   // LibreOffice
    file.type === 'application/epub+zip'
  ) return true;

  // Filename fallback — many code/config files have no MIME type in the browser
  return /\.(md|txt|csv|json|xml|yaml|yml|toml|ini|cfg|env|log|sql|sh|bash|zsh|ps1|bat|cmd|py|js|ts|jsx|tsx|html|htm|css|scss|sass|less|rb|go|rs|java|cpp|c|h|hpp|cs|php|lua|swift|kt|r|pl|ex|exs|hs|elm|ml|clj|scala|nim|zig|tf|hcl|dockerfile|makefile|gitignore|editorconfig)$/i.test(file.name);
};

/**
 * Returns true if the file is accepted by the canvas (image or readable document).
 */
export const isAcceptedFile = (file) => isImageFile(file) || isDocumentFile(file);

/**
 * POST an image file to /canvas/image as base64 JSON.
 * @param {File} file
 * @param {string} backend  e.g. 'http://localhost:8000'
 * @returns {Promise<string>} resolves to the data URI
 */
export const uploadImage = (file, backend) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const dataUri = ev.target.result;
      resolve(dataUri); // resolve early so UI can show immediately
      try {
        await fetch(`${backend}/canvas/image`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ image_data: dataUri, filename: file.name }),
        });
      } catch (err) {
        console.error('[canvasDrop] Failed to send image to AURA:', err);
      }
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

/**
 * POST a document file to /canvas/document as multipart form data.
 * Multipart avoids base64 overhead — handles large files cleanly.
 * @param {File} file
 * @param {string} backend
 */
export const uploadDocument = async (file, backend) => {
  const form = new FormData();
  form.append('file', file, file.name);
  try {
    await fetch(`${backend}/canvas/document`, {
      method: 'POST',
      body:   form,
    });
  } catch (err) {
    console.error('[canvasDrop] Failed to send document to AURA:', err);
  }
};

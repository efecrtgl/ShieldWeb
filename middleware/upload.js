const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const config = require("../config");
const { wantsJson } = require("../utils/http");

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const storage = multer.diskStorage({
  destination(req, file, cb) {
    fs.mkdirSync(config.uploadsDir, { recursive: true });
    cb(null, config.uploadsDir);
  },
  filename(req, file, cb) {
    cb(null, `${Date.now()}-${crypto.randomInt(1e9)}${path.extname(file.originalname).toLowerCase()}`);
  }
});

// SVG is excluded on purpose: it can carry script and is served from the site's own origin.
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

// Uploads served from /public/uploads must be images; anything else could be served as HTML/JS.
const imageUpload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext) && (file.mimetype || "").startsWith("image/")) return cb(null, true);
    cb(new Error("Sadece resim dosyaları yüklenebilir."));
  }
});

// Role backup JSON is kept in memory only, so it never lands in the public uploads folder.
const jsonUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter(req, file, cb) {
    if (path.extname(file.originalname).toLowerCase() === ".json") return cb(null, true);
    cb(new Error("Sadece .json yedek dosyaları yüklenebilir."));
  }
});

// Single-file upload middleware that answers 400 for rejected files instead of a 500 page.
function singleFile(uploader, fieldName) {
  const handler = uploader.single(fieldName);
  return (req, res, next) => handler(req, res, err => {
    if (!err) return next();
    const message = err.code === "LIMIT_FILE_SIZE" ? "Dosya boyutu çok büyük (en fazla 10MB)." : err.message;
    if (wantsJson(req)) return res.status(400).json({ success: false, message });
    res.status(400).send(message);
  });
}

module.exports = {
  imageFile: fieldName => singleFile(imageUpload, fieldName),
  jsonFile: fieldName => singleFile(jsonUpload, fieldName)
};

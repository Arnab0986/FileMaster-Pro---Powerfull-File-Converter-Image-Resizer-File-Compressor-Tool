// backend/server.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const sharp = require('sharp'); // image processing
const archiver = require('archiver'); // for zips
const { exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 5000;

// Serve frontend static
app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.use(express.json());
app.use(cors());

// Make sure uploads dir exists
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// multer setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // keep original extension
    const ext = path.extname(file.originalname);
    const name = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, name);
  }
});
const upload = multer({ storage });

// Helper: safe delete
function safeUnlink(p) {
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { /* ignore */ }
}

// ---------- Convert endpoint ----------
app.post('/api/convert', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded');
  const convertTo = (req.body.convertTo || '').toLowerCase();
  const inputPath = req.file.path;
  const origName = path.parse(req.file.originalname).name;

  // Allowed simple image conversions handled via sharp
  const imageTargets = ['jpg', 'jpeg', 'png', 'webp', 'tiff', 'avif'];
  // Audio/video handled by ffmpeg if available
  const mediaTargets = ['mp3', 'wav', 'ogg', 'mp4', 'mov', 'webm', 'mkv'];

  try {
    if (imageTargets.includes(convertTo)) {
      const outPath = path.join(UPLOAD_DIR, `${origName}-${Date.now()}.${convertTo}`);
      await sharp(inputPath).toFile(outPath);
      res.download(outPath, path.basename(outPath), (err) => {
        safeUnlink(inputPath);
        safeUnlink(outPath);
      });
      return;
    }

    if (mediaTargets.includes(convertTo)) {
      // requires ffmpeg installed on host
      const outPath = path.join(UPLOAD_DIR, `${origName}-${Date.now()}.${convertTo}`);
      const cmd = `ffmpeg -y -i "${inputPath}" "${outPath}"`;
      exec(cmd, { windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          console.error('ffmpeg error', err, stderr);
          safeUnlink(inputPath);
          return res.status(500).send('Conversion failed (ffmpeg error)');
        }
        res.download(outPath, path.basename(outPath), () => {
          safeUnlink(inputPath);
          safeUnlink(outPath);
        });
      });
      return;
    }

    if (convertTo === 'pdf') {
      // If input is image, convert using sharp -> pdf
      const outPath = path.join(UPLOAD_DIR, `${origName}-${Date.now()}.pdf`);
      const mime = req.file.mimetype || '';
      if (mime.startsWith('image/')) {
        await sharp(inputPath).pdf().toFile(outPath);
        res.download(outPath, path.basename(outPath), () => {
          safeUnlink(inputPath);
          safeUnlink(outPath);
        });
        return;
      }

      // For docx/odt -> pdf conversion use libreoffice if available
      const ext = path.extname(req.file.originalname).toLowerCase();
      if (['.doc', '.docx', '.odt', '.rtf'].includes(ext)) {
        // libreoffice --headless --convert-to pdf --outdir <UPLOAD_DIR> <file>
        const cmd = `libreoffice --headless --convert-to pdf --outdir "${UPLOAD_DIR}" "${inputPath}"`;
        exec(cmd, { windowsHide: true }, (err) => {
          if (err) {
            console.error('libreoffice error', err);
            safeUnlink(inputPath);
            return res.status(500).send('Conversion failed (libreoffice error)');
          }
          // output will be same base name but .pdf
          const expected = path.join(UPLOAD_DIR, `${path.parse(req.file.originalname).name}.pdf`);
          // sometimes libreoffice uses same name without timestamp — handle fallback
          const outFile = fs.existsSync(expected) ? expected : outPath;
          res.download(outFile, path.basename(outFile), () => {
            safeUnlink(inputPath);
            safeUnlink(outFile);
          });
        });
        return;
      }
    }

    // If unsupported
    safeUnlink(inputPath);
    return res.status(400).send('Unsupported conversion target');
  } catch (err) {
    console.error(err);
    safeUnlink(inputPath);
    return res.status(500).send('Conversion error');
  }
});

// ---------- Resize endpoint ----------
app.post('/api/resize', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).send('No image uploaded');
  const { width, height, targetSize } = req.body;
  const inputPath = req.file.path;
  const origName = path.parse(req.file.originalname).name;
  const outPath = path.join(UPLOAD_DIR, `${origName}-resized-${Date.now()}.jpg`);

  try {
    let img = sharp(inputPath).rotate(); // auto-orient
    const w = width ? parseInt(width) : null;
    const h = height ? parseInt(height) : null;
    if (w || h) img = img.resize(w, h, { fit: 'inside', withoutEnlargement: true });

    // If targetSize (KB) is provided, perform iterative quality reduction
    if (targetSize) {
      const targetBytes = parseInt(targetSize) * 1024;
      // Start with quality 90 and reduce
      let quality = 90;
      let buffer = await img.jpeg({ quality }).toBuffer();
      while (buffer.length > targetBytes && quality > 10) {
        quality -= 10;
        buffer = await img.jpeg({ quality }).toBuffer();
      }
      fs.writeFileSync(outPath, buffer);
    } else {
      // default output as jpeg
      await img.jpeg({ quality: 85 }).toFile(outPath);
    }

    res.download(outPath, path.basename(outPath), () => {
      safeUnlink(inputPath);
      safeUnlink(outPath);
    });
  } catch (err) {
    console.error(err);
    safeUnlink(inputPath);
    return res.status(500).send('Resize failed');
  }
});

// ---------- Compress endpoint ----------
app.post('/api/compress', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded');
  const level = (req.body.level || 'medium').toLowerCase();
  const inputPath = req.file.path;
  const outZip = path.join(UPLOAD_DIR, `${path.parse(req.file.originalname).name}-${Date.now()}.zip`);

  try {
    const output = fs.createWriteStream(outZip);
    const archive = archiver('zip', { zlib: { level: level === 'low' ? 1 : level === 'high' ? 9 : 5 } });
    archive.pipe(output);
    archive.file(inputPath, { name: req.file.originalname });
    archive.finalize();

    output.on('close', () => {
      res.download(outZip, path.basename(outZip), () => {
        safeUnlink(inputPath);
        safeUnlink(outZip);
      });
    });
  } catch (err) {
    console.error(err);
    safeUnlink(inputPath);
    return res.status(500).send('Compression failed');
  }
});

// Fallback to frontend index (for SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));

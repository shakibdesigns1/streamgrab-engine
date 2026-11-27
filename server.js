const http = require("http");
const { spawn, execSync } = require("child_process");
const { Readable } = require("stream");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PORT = parseInt(process.env.PORT || "7860", 10);
const HOST = "0.0.0.0";
const TEMP_DIR = path.join(os.tmpdir(), "streamgrab_cloud");

fs.mkdirSync(TEMP_DIR, { recursive: true });

function hasBinary(cmd) {
  try {
    execSync(`${cmd} --version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const BIN_STATUS = {
  ytdlp: hasBinary("yt-dlp"),
  ffmpeg: hasBinary("ffmpeg")
};

// Short-lived in-memory stream tokens (zero disk usage for large videos)
const streamTokens = new Map();

function sanitize(name, maxLen = 85) {
  return (name || "video")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen) || "video";
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 5 * 1024 * 1024) reject(new Error("Payload too large"));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function writeTempCookies(cookiesTxt) {
  if (!cookiesTxt || typeof cookiesTxt !== "string" || !cookiesTxt.trim()) {
    return null;
  }
  const cookiePath = path.join(
    TEMP_DIR,
    `ck_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`
  );
  fs.writeFileSync(cookiePath, cookiesTxt, { encoding: "utf8", mode: 0o600 });
  return cookiePath;
}

function removeFileQuietly(filePath) {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

function buildFormatOptions(info) {
  const rawFormats = Array.isArray(info.formats) ? info.formats : [];
  const heights = new Set();
  let hasNativeWebm = false;

  for (const f of rawFormats) {
    if (f.ext === "mhtml" || f.protocol === "mhtml") continue;
    if (f.vcodec && f.vcodec !== "none" && f.height) {
      heights.add(f.height);
      if (f.ext === "webm") hasNativeWebm = true;
    }
  }

  const sortedHeights = Array.from(heights).sort((a, b) => b - a);
  const options = [
    {
      label: "Best Available",
      note: "Direct stream · Any size",
      preset: "best",
      container: "mp4",
      isAudio: false
    }
  ];

  const targetRes = [2160, 1440, 1080, 720, 480, 360];
  for (const h of targetRes) {
    if (sortedHeights.some((sh) => sh === h || (h === 2160 && sh >= 2000))) {
      options.push({
        label: h === 2160 ? "4K (2160p)" : h === 1440 ? "2K (1440p)" : `${h}p HD`,
        note: "MP4 Merged",
        preset: `${h}p`,
        container: "mp4",
        isAudio: false
      });
    }
  }

  if (hasNativeWebm) {
    options.push({
      label: "Best Quality (WebM)",
      note: "VP9 / Opus",
      preset: "best_webm",
      container: "webm",
      isAudio: false
    });
  }

  options.push(
    {
      label: "Best Quality (MKV)",
      note: "Lossless container",
      preset: "best",
      container: "mkv",
      isAudio: false
    },
    {
      label: "Audio Only (MP3)",
      note: "High quality audio",
      preset: "audio_mp3",
      container: "mp3",
      isAudio: true
    },
    {
      label: "Audio Only (M4A)",
      note: "AAC native audio",
      preset: "audio_m4a",
      container: "m4a",
      isAudio: true
    }
  );

  return options;
}

function getFormatSelector(formatPreset) {
  if (formatPreset === "best_webm") {
    return "bv*[ext=webm]+ba[ext=webm]/bv*+ba/b";
  }
  const heightMatch = (formatPreset || "").match(/^(\d+)p$/);
  if (heightMatch) {
    const h = heightMatch[1];
    return `bv*[height<=${h}]+ba/b[height<=${h}]/bv*+ba/b`;
  }
  return "bv*+ba/b";
}

function runYtDlpJson(targetUrl, cookiePath, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const args = [
      "-J",
      "--ignore-no-formats-error",
      "--no-playlist",
      "--no-warnings",
      ...extraArgs
    ];
    if (cookiePath) {
      args.push("--cookies", cookiePath);
    }
    args.push(targetUrl);

    const proc = spawn("yt-dlp", args);
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("error", () => {
      reject(new Error("yt-dlp binary missing in container."));
    });

    proc.on("close", (code) => {
      if (code !== 0 || !stdout.trim()) {
        return reject(new Error(stderr || "Probe failed"));
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("Failed to parse media metadata."));
      }
    });
  });
}

async function resolveVideoInfo(targetUrl, cookiesTxt, extraArgs = []) {
  const cookiePath = writeTempCookies(cookiesTxt);
  try {
    let info;
    try {
      info = await runYtDlpJson(targetUrl, cookiePath, extraArgs);
    } catch (firstErr) {
      if (/youtube\.com|youtu\.be/i.test(targetUrl)) {
        try {
          info = await runYtDlpJson(targetUrl, cookiePath, [
            ...extraArgs,
            "--extractor-args",
            "youtube:player_client=tv,web_safari,mweb"
          ]);
        } catch {
          throw firstErr;
        }
      } else {
        throw firstErr;
      }
    }

    if (info.is_drm || info.drm) {
      throw new Error("This video is DRM-protected and cannot be downloaded.");
    }
    return info;
  } catch (err) {
    const msg = err.message || "";
    if (/DRM|Widevine|protected/i.test(msg)) {
      throw new Error("This video is DRM-protected and cannot be downloaded.");
    }
    if (/Sign in to confirm|not a bot/i.test(msg)) {
      throw new Error("Sign into YouTube in Chrome and try again.");
    }
    if (/Unsupported URL/i.test(msg)) {
      throw new Error("UNSUPPORTED_SITE");
    }
    const cleanErr = msg
      .split("\n")
      .filter((l) => l.trim().startsWith("ERROR:"))
      .pop();
    throw new Error(cleanErr || "No extractor formats found.");
  } finally {
    removeFileQuietly(cookiePath);
  }
}

async function probeUrl(targetUrl, cookiesTxt) {
  const info = await resolveVideoInfo(targetUrl, cookiesTxt);
  return {
    url: targetUrl,
    title: info.title || "Video",
    duration: info.duration || 0,
    formats: buildFormatOptions(info)
  };
}

function formatFfmpegHeaders(httpHeaders = {}) {
  const lines = [];
  for (const [k, v] of Object.entries(httpHeaders || {})) {
    if (v != null && k.toLowerCase() !== "host") {
      lines.push(`${k}: ${String(v).replace(/[\r\n]+/g, " ")}`);
    }
  }
  return lines.length ? lines.join("\r\n") + "\r\n" : "";
}

// --- Zero-Disk Direct Stream Handler (Supports Multi-GB Videos on 512MB RAM!) ---
async function handleDirectStream(req, res, jobSpec) {
  const { url, formatPreset = "best", container = "mp4", title = "Video", cookiesTxt } = jobSpec;
  const safeTitle = sanitize(title);
  const outExt =
    formatPreset === "audio_mp3"
      ? "mp3"
      : formatPreset === "audio_m4a"
      ? "m4a"
      : container || "mp4";
  const outputFilename = `${safeTitle}.${outExt}`;
  const encodedName = encodeURIComponent(outputFilename);

  // 1. Audio extraction (MP3 / M4A) — small file, temp dir cleaned immediately on close
  if (formatPreset === "audio_mp3" || formatPreset === "audio_m4a") {
    const jobDir = path.join(TEMP_DIR, `aud_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(jobDir, { recursive: true });
    const cookiePath = writeTempCookies(cookiesTxt);
    const outTemplate = path.join(jobDir, `${safeTitle}.%(ext)s`);

    const args = [
      "--no-playlist",
      "--no-warnings",
      "-x",
      "--audio-format",
      outExt,
      "--audio-quality",
      "0",
      "-o",
      outTemplate
    ];
    if (cookiePath) args.push("--cookies", cookiePath);
    if (/youtube\.com|youtu\.be/i.test(url)) {
      args.push("--extractor-args", "youtube:player_client=tv,web_safari,default");
    }
    args.push(url);

    const proc = spawn("yt-dlp", args);
    proc.on("close", (code) => {
      removeFileQuietly(cookiePath);
      const cleanup = () => {
        try {
          fs.rmSync(jobDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      };

      if (code !== 0) {
        cleanup();
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: "Audio extraction failed." });
        return;
      }

      const files = fs.readdirSync(jobDir).filter((f) => !f.endsWith(".part"));
      if (!files.length) {
        cleanup();
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: "No audio output." });
        return;
      }

      const filePath = path.join(jobDir, files[0]);
      const stat = fs.statSync(filePath);
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": stat.size,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodedName}`,
        "Access-Control-Allow-Origin": "*"
      });
      const rs = fs.createReadStream(filePath);
      rs.on("close", cleanup);
      rs.on("error", cleanup);
      rs.pipe(res);
    });
    return;
  }

  // 2. Video stream: resolve exact stream URLs with yt-dlp -J (0 bytes written to disk!)
  const selector = getFormatSelector(formatPreset);
  const info = await resolveVideoInfo(url, cookiesTxt, ["-f", selector]);

  // Case 2A: Single progressive direct HTTP file (e.g. Facebook SD/HD MP4, direct CDN MP4)
  if (!info.requested_formats && info.url && /^https?:\/\//i.test(info.url) && !String(info.protocol || "").includes("m3u8")) {
    if (outExt === "mp4" || outExt === info.ext) {
      const upstream = await fetch(info.url, { headers: info.http_headers || {} });
      if (upstream.ok && upstream.body) {
        const respHeaders = {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodedName}`,
          "Access-Control-Allow-Origin": "*"
        };
        const len = upstream.headers.get("content-length");
        if (len) respHeaders["Content-Length"] = len;

        res.writeHead(200, respHeaders);
        const nodeStream = Readable.fromWeb(upstream.body);
        req.on("close", () => nodeStream.destroy());
        nodeStream.pipe(res);
        return;
      }
    }
  }

  // Case 2B: Split Video + Audio OR HLS stream -> Zero-Disk FFmpeg Live Mux Pipe!
  const ffArgs = ["-y", "-loglevel", "error"];

  if (Array.isArray(info.requested_formats) && info.requested_formats.length >= 2) {
    const vFmt = info.requested_formats[0];
    const aFmt = info.requested_formats[1];
    const vHeaders = formatFfmpegHeaders(vFmt.http_headers || info.http_headers);
    const aHeaders = formatFfmpegHeaders(aFmt.http_headers || info.http_headers);

    if (vHeaders) ffArgs.push("-headers", vHeaders);
    ffArgs.push("-i", vFmt.url);

    if (aHeaders) ffArgs.push("-headers", aHeaders);
    ffArgs.push("-i", aFmt.url);

    if (outExt === "webm") {
      const bothWebm = vFmt.ext === "webm" && aFmt.ext === "webm";
      if (bothWebm) {
        ffArgs.push("-c", "copy", "-f", "webm", "pipe:1");
      } else {
        ffArgs.push("-c:v", "libvpx-vp9", "-crf", "33", "-b:v", "0", "-deadline", "realtime", "-c:a", "libopus", "-f", "webm", "pipe:1");
      }
    } else if (outExt === "mkv") {
      ffArgs.push("-c", "copy", "-f", "matroska", "pipe:1");
    } else {
      ffArgs.push("-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1");
    }
  } else if (info.url) {
    const hdrs = formatFfmpegHeaders(info.http_headers);
    if (hdrs) ffArgs.push("-headers", hdrs);
    ffArgs.push("-i", info.url);

    if (outExt === "mkv") {
      ffArgs.push("-c", "copy", "-f", "matroska", "pipe:1");
    } else if (outExt === "webm") {
      ffArgs.push("-c:v", "libvpx-vp9", "-crf", "33", "-b:v", "0", "-deadline", "realtime", "-c:a", "libopus", "-f", "webm", "pipe:1");
    } else {
      ffArgs.push("-c", "copy", "-bsf:a", "aac_adtstoasc", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1");
    }
  } else {
    throw new Error("No streamable URL resolved.");
  }

  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodedName}`,
    "Access-Control-Allow-Origin": "*"
  });

  const ff = spawn("ffmpeg", ffArgs);
  ff.stdout.pipe(res);

  ff.stderr.on("data", (d) => {
    console.error("[ffmpeg]", d.toString().trim());
  });

  req.on("close", () => {
    try {
      ff.kill("SIGKILL");
    } catch {
      // ignore
    }
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    return sendJson(res, 200, { ok: true });
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  try {
    if (req.method === "GET" && (reqUrl.pathname === "/" || reqUrl.pathname === "/health")) {
      return sendJson(res, 200, {
        ok: true,
        mode: "cloud-stream",
        ytdlp: BIN_STATUS.ytdlp,
        ffmpeg: BIN_STATUS.ffmpeg
      });
    }

    if (req.method === "POST" && reqUrl.pathname === "/probe") {
      const body = await readBody(req);
      if (!body.url) return sendJson(res, 400, { ok: false, error: "URL is required." });
      const result = await probeUrl(body.url, body.cookiesTxt);
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (req.method === "POST" && reqUrl.pathname === "/prepare") {
      const body = await readBody(req);
      if (!body.url) return sendJson(res, 400, { ok: false, error: "URL is required." });

      const token = `tok_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const safeTitle = sanitize(body.title || "Video");
      const outExt =
        body.formatPreset === "audio_mp3"
          ? "mp3"
          : body.formatPreset === "audio_m4a"
          ? "m4a"
          : body.container || "mp4";

      streamTokens.set(token, {
        url: body.url,
        formatPreset: body.formatPreset || "best",
        container: outExt,
        title: safeTitle,
        cookiesTxt: body.cookiesTxt || "",
        createdAt: Date.now()
      });

      setTimeout(() => streamTokens.delete(token), 3 * 60 * 1000);

      return sendJson(res, 200, {
        ok: true,
        token,
        filename: `${safeTitle}.${outExt}`
      });
    }

    if (req.method === "GET" && reqUrl.pathname.startsWith("/stream/")) {
      const token = reqUrl.pathname.slice("/stream/".length);
      const spec = streamTokens.get(token);
      if (!spec) {
        return sendJson(res, 404, { ok: false, error: "Download token expired." });
      }
      streamTokens.delete(token);
      await handleDirectStream(req, res, spec);
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: err.message || "Server error" });
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`StreamGrab Pro Zero-Disk Cloud Engine listening on http://${HOST}:${PORT}`);
});

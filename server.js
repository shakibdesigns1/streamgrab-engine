const http = require("http");
const { spawn, execSync } = require("child_process");
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

const jobs = new Map();

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

  for (const f of rawFormats) {
    if (f.ext === "mhtml" || f.protocol === "mhtml") continue;
    if (f.vcodec && f.vcodec !== "none" && f.height) {
      heights.add(f.height);
    }
  }

  const sortedHeights = Array.from(heights).sort((a, b) => b - a);
  const options = [
    {
      label: "Best Available",
      note: "Auto-merged video + audio",
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

  options.push(
    {
      label: "Best Quality (WebM)",
      note: "VP9 / Opus",
      preset: "best",
      container: "webm",
      isAudio: false
    },
    {
      label: "Best Quality (MKV)",
      note: "Lossless mux",
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

function runProbeAttempt(targetUrl, cookiePath, extraArgs = []) {
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
        const info = JSON.parse(stdout);
        resolve(info);
      } catch {
        reject(new Error("Failed to parse media metadata."));
      }
    });
  });
}

async function probeUrl(targetUrl, cookiesTxt) {
  const cookiePath = writeTempCookies(cookiesTxt);
  try {
    let info;
    try {
      info = await runProbeAttempt(targetUrl, cookiePath);
    } catch (firstErr) {
      if (/youtube\.com|youtu\.be/i.test(targetUrl)) {
        try {
          info = await runProbeAttempt(targetUrl, cookiePath, [
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

    return {
      url: targetUrl,
      title: info.title || "Video",
      duration: info.duration || 0,
      formats: buildFormatOptions(info)
    };
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

function scheduleCleanup(jobDir, delayMs = 15 * 60 * 1000) {
  setTimeout(() => {
    try {
      fs.rmSync(jobDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }, delayMs);
}

function startDownloadJob({ url, formatPreset = "best", container = "mp4", title = "Video", cookiesTxt }) {
  const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const safeTitle = sanitize(title);
  const jobDir = path.join(TEMP_DIR, id);
  fs.mkdirSync(jobDir, { recursive: true });

  const cookiePath = writeTempCookies(cookiesTxt);
  const outTemplate = path.join(jobDir, `${safeTitle}.%(ext)s`);

  const args = [
    "--newline",
    "--progress",
    "--no-playlist",
    "--no-warnings",
    "-o",
    outTemplate
  ];

  if (cookiePath) {
    args.push("--cookies", cookiePath);
  }

  if (/youtube\.com|youtu\.be/i.test(url)) {
    args.push("--extractor-args", "youtube:player_client=tv,web_safari,default");
  }

  if (formatPreset === "audio_mp3") {
    args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
  } else if (formatPreset === "audio_m4a") {
    args.push("-x", "--audio-format", "m4a", "--audio-quality", "0");
  } else {
    const heightMatch = formatPreset.match(/^(\d+)p$/);
    if (heightMatch) {
      const h = heightMatch[1];
      args.push("-f", `bv*[height<=${h}]+ba/b[height<=${h}]/bv*+ba/b`);
    } else {
      args.push("-f", "bv*+ba/b");
    }
    args.push("--merge-output-format", container || "mp4");
  }

  args.push(url);

  const proc = spawn("yt-dlp", args);

  const job = {
    id,
    title: safeTitle,
    container: container || "mp4",
    percent: 0,
    totalSize: "",
    speed: "",
    status: "starting",
    filePath: null,
    outputFilename: `${safeTitle}.${container || "mp4"}`,
    error: null,
    pid: proc.pid
  };

  jobs.set(id, job);

  let stderrTail = "";

  const parseProgressLine = (line) => {
    const dlMatch = line.match(/\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.\w]+)(?:\s+at\s+([\d.\w/]+))?/);
    if (dlMatch) {
      job.status = "downloading";
      job.percent = Math.min(99, Math.round(parseFloat(dlMatch[1])));
      job.totalSize = dlMatch[2] || job.totalSize;
      job.speed = dlMatch[3] || job.speed;
      return;
    }
    if (/\[Merger\]|\[ExtractAudio\]|Merging formats/i.test(line)) {
      job.status = "merging";
      job.percent = 99;
    }
    if (line.trim().startsWith("ERROR:")) {
      stderrTail = line.trim();
    }
  };

  proc.stdout.on("data", (chunk) => {
    chunk.toString().split(/\r?\n/).forEach(parseProgressLine);
  });

  proc.stderr.on("data", (chunk) => {
    chunk.toString().split(/\r?\n/).forEach(parseProgressLine);
  });

  proc.on("error", (err) => {
    removeFileQuietly(cookiePath);
    job.status = "error";
    job.error = err.message;
    scheduleCleanup(jobDir, 60 * 1000);
  });

  proc.on("close", (code) => {
    removeFileQuietly(cookiePath);

    if (job.status === "cancelled") {
      scheduleCleanup(jobDir, 5000);
      return;
    }
    if (code === 0) {
      const files = fs.readdirSync(jobDir).filter((f) => !f.endsWith(".part") && !f.endsWith(".ytdl"));
      if (files.length > 0) {
        job.filePath = path.join(jobDir, files[0]);
        job.outputFilename = files[0];
        job.status = "completed";
        job.percent = 100;
        job.speed = "Ready";
        scheduleCleanup(jobDir, 15 * 60 * 1000);
        return;
      }
    }
    job.status = "error";
    job.error = stderrTail || "Download failed or blocked by site.";
    scheduleCleanup(jobDir, 60 * 1000);
  });

  return job;
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
        mode: "cloud",
        ytdlp: BIN_STATUS.ytdlp,
        ffmpeg: BIN_STATUS.ffmpeg
      });
    }

    if (req.method === "GET" && reqUrl.pathname === "/jobs") {
      const publicJobs = Array.from(jobs.values())
        .reverse()
        .slice(0, 15)
        .map(({ filePath, pid, ...rest }) => rest);
      return sendJson(res, 200, { ok: true, jobs: publicJobs });
    }

    if (req.method === "GET" && reqUrl.pathname.startsWith("/file/")) {
      const jobId = reqUrl.pathname.slice("/file/".length);
      const job = jobs.get(jobId);
      if (!job || !job.filePath || !fs.existsSync(job.filePath)) {
        return sendJson(res, 404, { ok: false, error: "File expired or not ready." });
      }
      const stat = fs.statSync(job.filePath);
      const encodedName = encodeURIComponent(job.outputFilename);
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": stat.size,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodedName}`,
        "Access-Control-Allow-Origin": "*"
      });
      fs.createReadStream(job.filePath).pipe(res);
      return;
    }

    if (req.method === "POST" && reqUrl.pathname === "/probe") {
      const body = await readBody(req);
      if (!body.url) return sendJson(res, 400, { ok: false, error: "URL is required." });
      const result = await probeUrl(body.url, body.cookiesTxt);
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (req.method === "POST" && reqUrl.pathname === "/download") {
      const body = await readBody(req);
      if (!body.url) return sendJson(res, 400, { ok: false, error: "URL is required." });
      const job = startDownloadJob(body);
      const { filePath, pid, ...publicJob } = job;
      return sendJson(res, 200, { ok: true, job: publicJob });
    }

    if (req.method === "POST" && reqUrl.pathname === "/cancel") {
      const body = await readBody(req);
      const job = jobs.get(body.jobId);
      if (job && job.pid) {
        job.status = "cancelled";
        try {
          process.kill(job.pid, "SIGKILL");
        } catch {
          // ignore
        }
      }
      return sendJson(res, 200, { ok: true });
    }

    sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err.message || "Server error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`StreamGrab Pro Cloud Engine listening on http://${HOST}:${PORT}`);
});

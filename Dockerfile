FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ffmpeg nodejs && \
    pip install --no-cache-dir yt-dlp && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the Whisper model at build time so the first transcription on the
# Publish page is instant (no cold model fetch). Override size with WHISPER_MODEL.
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('base', device='cpu', compute_type='int8')"

COPY . .

RUN mkdir -p static/uploads

EXPOSE 5050

# Threaded workers: the publish view serves several 1-2MB /static/uploads PNGs at
# once. With plain sync workers (was: --workers 2) a handful of large image requests
# saturate every worker and the whole site goes unreachable. gthread + threads lets
# I/O-bound static serving run concurrently. get_db() is per-request (WAL), so safe.
CMD ["gunicorn", "--bind", "0.0.0.0:5050", "--workers", "3", "--threads", "8", "--worker-class", "gthread", "--timeout", "240", "app:app"]

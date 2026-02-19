FROM python:3.11-slim

WORKDIR /app

# Install dependencies only (these change rarely → layer cache)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Only the watchdog is baked in — agent scripts are pulled from GitHub at runtime
COPY watchdog.py .

# Keys directory — mount as named volume to persist RSA keys across restarts
RUN mkdir -p /root/.openbot/keys

ENTRYPOINT ["python", "watchdog.py"]

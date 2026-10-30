# Runs in the runner container before the tests: waits for the Docker daemon the testcontainers talk to.
set -eu
python - <<'PY'
import time
import urllib.request

deadline = time.monotonic() + 120
while True:
    try:
        urllib.request.urlopen('http://127.0.0.1:2375/_ping', timeout=3).read()
        break
    except OSError:
        if time.monotonic() > deadline:
            raise
        time.sleep(1)
PY

# Runs in the runner container before the tests: waits for the Docker daemon the testcontainers talk to.
i=0
until wget -qO- http://127.0.0.1:2375/_ping >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 120 ] || { echo "docker daemon không lên sau 120s"; exit 1; }
  sleep 1
done

# On top of the project's dev image: the test tools the project keeps out of its runtime image (uv sync --no-dev), so a run does not pip install.
ARG BASE
FROM ${BASE}
RUN uv pip install --python /usr/src/app/.venv/bin/python pytest pytest-flask pytest-mock pytest-forked
# uv leaves site-packages without .pyc, so every fresh pod spent ~6 s compiling flask, celery and sqlalchemy before the first test (measured 2026-11-01: 13 s -> 8 s to the first result).
# -o 0 explicitly: the base image builds with PYTHONOPTIMIZE set, which would write .opt-N.pyc files that the pods (PYTHONOPTIMIZE=0) ignore.
RUN /usr/src/app/.venv/bin/python -m compileall -q -j 0 -o 0 /usr/src/app/.venv/lib

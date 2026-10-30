# On top of the project's dev image: the test tools the project keeps out of its runtime image (uv sync --no-dev), so a run does not pip install.
ARG BASE
FROM ${BASE}
RUN uv pip install --python /usr/src/app/.venv/bin/python pytest pytest-flask pytest-mock pytest-forked

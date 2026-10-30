# The project's dependencies, dev group included (pytest, testcontainers), from the checkout's lock file; the PR's code arrives at run time.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libpq-dev gcc git && rm -rf /var/lib/apt/lists/*
ENV POETRY_VERSION=1.8.5 POETRY_VIRTUALENVS_IN_PROJECT=true POETRY_NO_INTERACTION=1
RUN pip install --no-cache-dir "poetry==$POETRY_VERSION"
WORKDIR /opt/venv
COPY pyproject.toml poetry.lock ./
RUN poetry install --no-root
ENV PATH=/opt/venv/.venv/bin:$PATH

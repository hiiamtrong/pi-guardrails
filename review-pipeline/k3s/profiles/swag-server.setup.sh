# Runs in the runner container before the tests: waits for the databases, initiates Mongo, builds the Postgres schema, writes /tmp/rv.env.
# shortcut: the settings below mirror tests/services.py `_service_environ` (all services on localhost); change them together.
set -eu
cd /usr/src/app
# The PR's code arrives as sources only (tar drops __pycache__); compile it while the databases come up instead of letting the first pytest do it serially.
python -m compileall -q -j 0 -o 0 swag libs tests >/dev/null 2>&1 &
COMPILE=$!
python - <<'PY'
import time

import psycopg
import pymongo
import pymongo.errors
import redis

deadline = time.monotonic() + 180


def wait(call, not_yet):
    while True:
        try:
            return call()
        except not_yet:
            if time.monotonic() > deadline:
                raise
            time.sleep(0.5)


wait(lambda: psycopg.connect('host=127.0.0.1 dbname=swag_test user=swag password=swag', connect_timeout=3).close(), psycopg.OperationalError)
mongo = pymongo.MongoClient('127.0.0.1', 27017, directConnection=True, serverSelectionTimeoutMS=3000)
wait(lambda: mongo.admin.command('ping'), pymongo.errors.ConnectionFailure)
mongo.admin.command('replSetInitiate', {'_id': 'swag-test', 'members': [{'_id': 0, 'host': 'localhost:27017'}]})


def primary():
    if not mongo.admin.command('hello')['isWritablePrimary']:
        raise pymongo.errors.ConnectionFailure('not primary yet')


wait(primary, pymongo.errors.ConnectionFailure)
wait(lambda: redis.Redis('127.0.0.1', socket_connect_timeout=3).ping(), redis.exceptions.ConnectionError)
PY
R='redis://127.0.0.1:6379'
C='?max_connections=20&socket_connect_timeout=5&protocol=3'
cat > /tmp/rv.env <<ENV
export MONGO_URL='mongodb://127.0.0.1:27017/swag_test?directConnection=true&replicaSet=swag-test'
export POSTGRES_URL='postgresql+psycopg://swag:swag@127.0.0.1:5432/swag_test'
export REDIS_URL='$R/15'
export CACHE_REDIS_URL='$R/0$C'
export CACHE_REDIS_URL_CACHE_P='$R/1$C'
export CACHE_REDIS_URL_CACHE_EVENTS='$R/4$C'
export CACHE_REDIS_URL_CACHE_COMMON='$R/5$C'
export CACHE_REDIS_URL_CACHE_LIVESTREAM='$R/6$C'
export CACHE_REDIS_URL_CACHE_REALTIME='$R/6$C'
export CACHE_REDIS_URL_CACHE_USER_ATTRIBUTES='$R/7$C'
export CACHE_REDIS_IAM_AUTH_CACHE_USER_ATTRIBUTES='0'
export CELERY_BROKER_URL='$R/9'
export CELERY_BROKER_READ_URL='$R/9'
export CELERY_BROKER_WRITE_URL='$R/9'
export CELERY_RESULT_BACKEND='$R/8'
export RATELIMIT_STORAGE_URI='$R/3?max_connections=1&socket_connect_timeout=5&protocol=3'
ENV
. /tmp/rv.env
python -m alembic upgrade head > /tmp/alembic.log 2>&1 || { tail -20 /tmp/alembic.log; exit 1; }
wait $COMPILE || true

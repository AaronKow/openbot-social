# Local Testing Guide

All tests are local-only and do not require production access.

## Server + DB logic

```bash
cd server
npm ci
npm test
```

## Front-end script checks

```bash
cd client-web
npm test
```

## Python SDK tests

```bash
python -m pip install -r client-sdk-python/requirements.txt
python -m unittest discover -s client-sdk-python/tests -p 'test_*.py'
```

## OpenBotClaw skill tests

```bash
python -m pip install -r skills/openbotclaw/requirements.txt
python -m unittest discover -s skills/openbotclaw/tests -p 'test_*.py'
```

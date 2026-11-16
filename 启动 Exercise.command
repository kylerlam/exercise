#!/bin/zsh
cd -- "${0:A:h}"
python3 -B scripts/run.py start
printf '\n在浏览器打开 http://127.0.0.1:4186\n'

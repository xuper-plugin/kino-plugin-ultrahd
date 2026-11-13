#!/bin/sh
# Corre el generador del Home en el Mac del autor (IP residencial Colombia → alcanza los servidores que usan los usuarios)
# y publica home/*.json en el repo. Lo dispara launchd cada 4 h. Idempotente: si no cambió nada, no commitea.
#
# Trabaja en un CLON DEDICADO (no en el repo de trabajo del autor), así nunca pisa cambios sin commitear.
set -e
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

REMOTE="https://github.com/xuper-plugin/kino-plugin-ultrahd.git"
WORK="$HOME/.cache/kino-home-gen"

# Llave de TMDB: la del build de la app Kino (para pósters). Si no está, el generador igual corre (pósters del IPTV).
if [ -f "$HOME/kino-light/.env" ]; then
  RAW=$(grep -E '^API_KEY=' "$HOME/kino-light/.env" | head -1 | cut -d= -f2-)
  KINO_TMDB_KEY=$(printf '%s' "$RAW" | tr -d '"' | tr -d "'" | tr -d '\r\n ')
  export KINO_TMDB_KEY
fi

if [ ! -d "$WORK/.git" ]; then
  mkdir -p "$(dirname "$WORK")"
  git clone -q "$REMOTE" "$WORK"
fi
cd "$WORK"
git fetch -q origin main
git reset -q --hard origin/main   # seguro: clon dedicado

rm -rf home
node scripts/gen-home.mjs

git add home
if git diff --cached --quiet; then
  echo "$(date '+%F %T') sin cambios en home/"
  exit 0
fi
git -c user.name=xuper-plugin -c user.email=335105665+xuper-plugin@users.noreply.github.com \
  commit -q -m "Home pre-armado (Mac): actualiza home/*.json"
git push -q origin HEAD:main
echo "$(date '+%F %T') publicado"

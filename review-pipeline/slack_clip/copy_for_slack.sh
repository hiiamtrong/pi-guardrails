set -eu
here=$(cd "$(dirname "$0")" && pwd)
md=$1
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
python3 -I "$here/md_to_html.py" "$md" > "$tmp/message.html"
osascript -l JavaScript "$here/set_clipboard.js" "$tmp/message.html" "$md"
echo "bullets in the file: $(grep -c '^• ' "$md") | list items in the HTML: $(grep -o '<li>' "$tmp/message.html" | wc -l | tr -d ' ')"

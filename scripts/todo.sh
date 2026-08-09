#!/usr/bin/env bash
# List TODO comments with author / date from git blame.
# Called by the `make todo` target.

set -euo pipefail

todo_cache=$(mktemp)
blame_cache=$(mktemp)
trap 'rm -f "$todo_cache" "$blame_cache"' EXIT

# Step 1: Find and clean TODO lines (same sed filters as the previous Makefile target).
grep -rn 'TODO' src test *.md 2>/dev/null | grep -v '^AGENTS\.md:' \
    | sed -E \
        -e 's/^([^:]*:[^:]*:)[[:space:]]*(\/\/|#|\/\*|\*|<!--)*[[:space:]]*/\1/' \
        -e 's/^([^:]*:[^:]*:)[[:space:]]*(-|[0-9]+\.)[[:space:]]*/\1/' \
        -e 's/^([^:]*:[^:]*:)[[:space:]]*TODO:?[[:space:]]*/\1/' \
        -e 's/^([^:]*:[^:]*:)[[:space:]]*\*\*(.+)\*\*[[:space:]]*$/\1\2/' \
        -e 's/^([^:]*:[^:]*:)[[:space:]]*__(.+)__[[:space:]]*$/\1\2/' \
        -e 's/^([^:]*:[^:]*:)[[:space:]]*\*(.+)\*[[:space:]]*$/\1\2/' \
        -e 's/^([^:]*:[^:]*:)[[:space:]]*_(.+)_[[:space:]]*$/\1\2/' \
        -e 's/^([^:]*:[^:]*:)[[:space:]]*TODO:?[[:space:]]*/\1/' \
    > "$todo_cache" || true

if [ ! -s "$todo_cache" ]; then
    exit 0
fi

# Step 2: Unique files containing TODOs, split into tracked / untracked.
all_files=$(cut -d: -f1 < "$todo_cache" | sort -u)
tracked_files=""
untracked_files=""
for file in $all_files; do
    if [ -n "$(git ls-files -- "$file" 2>/dev/null)" ]; then
        tracked_files="$tracked_files $file"
    else
        untracked_files="$untracked_files $file"
    fi
done

# Step 3a: Blame tracked files (one git invocation per file).
for file in $tracked_files; do
    git blame --date=format-local:%Y-%m-%d -- "$file" 2>/dev/null | awk -v f="$file" '
    {
        s = $0
        sub(/^[^(]*\(/, "", s)
        meta = s
        sub(/\).*/, "", meta)
        if (match(meta, /[0-9]{4}-[0-9]{2}-[0-9]{2}/)) {
            date = substr(meta, RSTART, RLENGTH)
            author = substr(meta, 1, RSTART - 1)
            gsub(/[[:space:]]+$/, "", author)
            gsub(/^[[:space:]]+/, "", author)
            lnum = substr(meta, RSTART + RLENGTH)
            gsub(/[[:space:]]+/, "", lnum)
            printf "%s:%s\t%s %s\n", f, lnum, date, author
        }
    }'
done > "$blame_cache" || true

# Step 3b: Use mtime + <untracked> for untracked files.
for file in $untracked_files; do
    mtime=$(stat -f '%Sm' -t '%Y-%m-%d' -- "$file" 2>/dev/null \
        || stat -c '%y' -- "$file" 2>/dev/null | cut -d' ' -f1)
    line_count=$(wc -l < "$file" 2>/dev/null | tr -d '[:space:]')
    for ((i = 1; i <= line_count; i++)); do
        printf '%s:%s\t%s <untracked>\n' "$file" "$i" "$mtime"
    done
done >> "$blame_cache" || true

# Step 4: Join TODO lines with blame data.
awk -v blame="$blame_cache" '
BEGIN {
    while ((getline line < blame) > 0) {
        pos = index(line, "\t")
        key = substr(line, 1, pos - 1)
        val = substr(line, pos + 1)
        idx[key] = val
    }
    close(blame)
}
{
    pos = index($0, ":")
    file = substr($0, 1, pos - 1)
    rest = substr($0, pos + 1)
    pos = index(rest, ":")
    lnum = substr(rest, 1, pos - 1)
    content = substr(rest, pos + 1)
    gsub(/^[[:space:]]+/, "", content)
    key = file ":" lnum
    if (key in idx) {
        printf "%s · %s:%s %s\n", idx[key], file, lnum, content
    } else {
        printf "          -           %s:%s %s\n", file, lnum, content
    }
}
' < "$todo_cache"

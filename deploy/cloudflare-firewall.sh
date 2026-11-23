#!/usr/bin/env bash
# Lets only Cloudflare's ranges reach ports 80 and 443 (TCP, and UDP 443),
# for an instance behind Cloudflare's proxy (OTTERTRAIL_PROXY=cloudflare;
# docs/deployment.md, "Behind Cloudflare's proxy"). Run with sudo, beside
# compose.yaml, on a server with UFW active:
#
#   sudo ./cloudflare-firewall.sh            write the rules and reload UFW
#   ./cloudflare-firewall.sh --check         print what it would write; changes nothing
#   sudo ./cloudflare-firewall.sh --remove   take the rules out again
#
# UFW's own rules cannot restrict Docker's published ports: Docker's
# iptables rules see those packets first. Docker passes them through its
# DOCKER-USER chain, which this fills. The rules go into
# /etc/ufw/after.rules and after6.rules between marker lines, so they come
# back after a reboot; running it again replaces them. They match ports 80
# and 443 only: SSH and every other port stay as they are.
#
# It reads the ranges from compose.yaml beside it (the caddy-proxy-cloudflare
# config), or else from https://www.cloudflare.com/ips-v4 and ips-v6. It
# needs Docker running with its iptables firewall, and checks that the
# rules are in force afterwards.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
compose="$here/compose.yaml"
ufw_dir=${UFW_DIR:-/etc/ufw}
chain=ottertrail-cloudflare
begin="# BEGIN ottertrail-cloudflare (written by cloudflare-firewall.sh; edits here are replaced)"
end="# END ottertrail-cloudflare"

usage() {
  echo "Usage: $0 [--check | --remove]" >&2
  exit 1
}

mode=install
case "${1:-}" in
  "") ;;
  --check) mode=check ;;
  --remove) mode=remove ;;
  *) usage ;;
esac
[ $# -le 1 ] || usage

# As scripts/update-cloudflare-ranges.ts checks them: Cloudflare's widest are
# a /13 and a /29, and it has 15 and 7 ranges (November 2026).
min_v4=12
min_v6=5
v4_pattern='^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})/(1[2-9]|2[0-9]|3[0-2])$'
# Global unicast (2000::/3), at most a /28.
v6_pattern='^[23][0-9a-f]{3}:[0-9a-f:]*/(2[89]|[3-9][0-9]|1[01][0-9]|12[0-8])$'

# Whether $1 is a routable IPv4 range written from its first address: none
# of 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16, 224/3.
v4_routable() {
  [[ $1 =~ $v4_pattern ]] || return 1
  local a=${BASH_REMATCH[1]} b=${BASH_REMATCH[2]} c=${BASH_REMATCH[3]} d=${BASH_REMATCH[4]}
  local bits=${BASH_REMATCH[5]} n
  for n in "$a" "$b" "$c" "$d"; do [ "$((10#$n))" -le 255 ] || return 1; done
  n=$(((10#$a << 24) | (10#$b << 16) | (10#$c << 8) | 10#$d))
  [ $((n & ((1 << (32 - bits)) - 1))) -eq 0 ] || return 1
  local end=$((n | ((1 << (32 - bits)) - 1))) reserved from to
  for reserved in 0:8 10:8 100.64:10 127:8 169.254:16 172.16:12 192.168:16 224:3; do
    IFS=. read -r ra rb <<< "${reserved%%:*}"
    from=$(((10#$ra << 24) | (10#${rb:-0} << 16)))
    to=$((from | ((1 << (32 - ${reserved#*:})) - 1)))
    [ "$n" -gt "$to" ] || [ "$end" -lt "$from" ] || return 1
  done
}

v6_routable() {
  [[ $1 =~ $v6_pattern ]] && [[ $1 != 2002:* ]]
}

# Every range from trusted_proxies in compose.yaml, one per line.
ranges_from_compose() {
  awk '$1 == "trusted_proxies" && $2 == "static" { for (i = 3; i <= NF; i++) print $i }' "$1"
}

# Both lists, or a failure for either download.
ranges_from_cloudflare() {
  local url list
  for url in https://www.cloudflare.com/ips-v4 https://www.cloudflare.com/ips-v6; do
    if command -v curl > /dev/null; then
      list=$(curl -fsS --max-time 30 "$url") || return 1
    else
      list=$(wget -q -T 30 -O - "$url") || return 1
    fi
    printf '%s\n' "$list"
  done
}

# Splits the ranges on stdin into v4 and v6, refusing anything that is not
# a routable CIDR range, and a result too small to be Cloudflare's, as a
# list cut off at a line break would be.
v4=()
v6=()
sort_ranges() {
  local range
  while IFS= read -r range; do
    range=$(printf '%s' "$range" | tr -d '\r' | tr 'A-F' 'a-f')
    [ -n "$range" ] || continue
    if v4_routable "$range"; then
      v4+=("$range")
    elif v6_routable "$range"; then
      v6+=("$range")
    else
      echo "Not a routable CIDR range of Cloudflare's size: $range. Nothing was changed." >&2
      exit 1
    fi
  done
  if [ "${#v4[@]}" -lt "$min_v4" ] || [ "${#v6[@]}" -lt "$min_v6" ]; then
    echo "Only ${#v4[@]} IPv4 and ${#v6[@]} IPv6 ranges: too few to be Cloudflare's. Nothing was changed." >&2
    exit 1
  fi
}

# The rules for one family: $1 is ufw-before-input or ufw6-before-input,
# the rest are the ranges.
rules() {
  local before_input=$1 range port proto
  shift
  echo "$begin"
  echo "*filter"
  # Declaring a chain empties it on each load, so a reload never doubles a rule.
  echo ":DOCKER-USER - [0:0]"
  echo ":$chain - [0:0]"
  # Traffic from the containers themselves (outgoing, or to the server's own
  # address) passes; so does the server's own.
  echo "-A $chain -i lo -j RETURN"
  echo "-A $chain -i docker0 -j RETURN"
  echo "-A $chain -i br-+ -j RETURN"
  for range in "$@"; do
    echo "-A $chain -s $range -j RETURN"
  done
  echo "-A $chain -j DROP"
  # Published ports: DOCKER-USER sees packets after Docker's DNAT, so match
  # the port the client connected to, not the container's.
  for port in tcp:80 tcp:443 udp:443; do
    proto=${port%%:*}
    echo "-A DOCKER-USER -p $proto -m conntrack --ctstate DNAT --ctdir ORIGINAL --ctorigdstport ${port#*:} -j $chain"
  done
  # Connections Docker's userland proxy takes on the server itself, as for
  # IPv6 on a network without IPv6. UFW accepts established ones before this.
  for port in tcp:80 tcp:443 udp:443; do
    proto=${port%%:*}
    echo "-A $before_input -p $proto --dport ${port#*:} -j $chain"
  done
  echo "COMMIT"
  echo "$end"
}

# $1 without the marker block.
without_block() {
  awk -v begin="$begin" -v end="$end" '
    $0 == begin { skip = 1; next }
    skip && $0 == end { skip = 0; next }
    !skip { print }
  ' "$1"
}

# Rules in DOCKER-USER that are not this script's: a reload would empty it.
foreign_rules() {
  "$1" -S DOCKER-USER 2> /dev/null |
    grep -v -e '^-N DOCKER-USER$' -e '^-A DOCKER-USER -j RETURN$' -e "-j $chain\$" || true
}

# Deletes every jump to this script's chain from the running firewall, then
# the chain; fails when the chain is still there. UFW leaves DOCKER-USER and
# this chain alone when it reloads or stops.
remove_running() {
  local tool=$1 rule parts
  { "$tool" -S 2> /dev/null || true; } | { grep -e "^-A .* -j $chain\$" || true; } |
    while IFS= read -r rule; do
      read -ra parts <<< "${rule/#-A /-D }"
      "$tool" "${parts[@]}" || true
    done
  if "$tool" -S "$chain" > /dev/null 2>&1; then
    "$tool" -F "$chain" || true
    "$tool" -X "$chain" || true
  fi
  if "$tool" -S "$chain" > /dev/null 2>&1; then
    echo "$tool still has the $chain chain: see \`sudo $tool -S | grep $chain\`." >&2
    return 1
  fi
}

# Whether the running firewall holds rule $2 (split on spaces) in chain $1,
# with tool $3.
has_rule() {
  local parts
  read -ra parts <<< "$2"
  "${3:-iptables}" -C "$1" "${parts[@]}" > /dev/null 2>&1
}

# Writes $2 (the block, or nothing) into $1 in place of the old block.
write_rules() {
  local file=$1 block=$2 tmp
  if [ ! -f "$file" ]; then
    [ -n "$block" ] || return 0
    echo "$file is missing: is UFW installed?" >&2
    exit 1
  fi
  [ -f "$file.before-ottertrail" ] || cp -p "$file" "$file.before-ottertrail"
  tmp=$(mktemp "$file.XXXXXX")
  {
    without_block "$file"
    [ -z "$block" ] || printf '%s\n' "$block"
  } > "$tmp"
  chmod --reference="$file" "$tmp"
  mv "$tmp" "$file"
}

if [ "$mode" != remove ]; then
  if [ -f "$compose" ] && [ -n "$(ranges_from_compose "$compose")" ]; then
    from="$compose"
    list=$(ranges_from_compose "$compose")
  else
    from="https://www.cloudflare.com/ips-v4 and ips-v6"
    list=$(ranges_from_cloudflare) || {
      echo "Could not download Cloudflare's ranges, and no compose.yaml beside this script has them. Nothing was changed." >&2
      exit 1
    }
  fi
  sort_ranges <<< "$list"
  rules4=$(rules ufw-before-input "${v4[@]}")
  rules6=$(rules ufw6-before-input "${v6[@]}")
fi

if [ "$mode" = check ]; then
  echo "Ranges from $from: ${#v4[@]} IPv4, ${#v6[@]} IPv6."
  echo "Only these reach ports 80 and 443 (TCP) and 443 (UDP). Other ports, SSH included, are not matched."
  echo
  echo "== Block for $ufw_dir/after.rules"
  printf '%s\n' "$rules4"
  echo
  echo "== Block for $ufw_dir/after6.rules"
  printf '%s\n' "$rules6"
  exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "Run it with sudo (or --check to see what it would write)." >&2
  exit 1
fi
for tool in iptables ip6tables iptables-restore ip6tables-restore; do
  command -v "$tool" > /dev/null || { echo "$tool is missing. Nothing was changed." >&2; exit 1; }
done
ufw_status=$(ufw status 2> /dev/null || true)
ufw_active=false
case "$ufw_status" in "Status: active"*) ufw_active=true ;; esac

if [ "$mode" = remove ]; then
  write_rules "$ufw_dir/after.rules" ""
  write_rules "$ufw_dir/after6.rules" ""
  if [ "$ufw_active" = true ]; then ufw reload; fi
  remove_running iptables
  remove_running ip6tables
  echo "Removed: ports 80 and 443 are open to every address again, as UFW allows."
  exit 0
fi

if [ "$ufw_active" != true ]; then
  echo "UFW is not installed or not active, so it would not load the rules. Nothing was changed." >&2
  exit 1
fi
if ! has_rule FORWARD "-j DOCKER-USER"; then
  echo "iptables' FORWARD chain does not jump to DOCKER-USER: Docker is not running, or does not manage iptables (its nftables firewall, or \"iptables\": false). These rules would not apply. Nothing was changed." >&2
  exit 1
fi
# Without UFW's IPv6 rules (IPV6=no in /etc/default/ufw), after6.rules is
# never loaded, and UFW does not filter IPv6 at all.
ipv6=true
if ! ip6tables -S ufw6-before-input > /dev/null 2>&1; then
  ipv6=false
fi

for tool in iptables ip6tables; do
  [ "$tool" = iptables ] || [ "$ipv6" = true ] || continue
  foreign=$(foreign_rules "$tool")
  if [ -n "$foreign" ]; then
    echo "$tool's DOCKER-USER chain has rules this script did not write, and a reload would empty it:" >&2
    printf '%s\n' "$foreign" >&2
    echo "Nothing was changed. Merge them into the block by hand, or remove them first." >&2
    exit 1
  fi
done

# Check the blocks against the running firewall before writing anything.
printf '%s\n' "$rules4" | iptables-restore --test --noflush
if [ "$ipv6" = true ]; then
  printf '%s\n' "$rules6" | ip6tables-restore --test --noflush
fi

write_rules "$ufw_dir/after.rules" "$rules4"
if [ "$ipv6" = true ]; then
  write_rules "$ufw_dir/after6.rules" "$rules6"
else
  write_rules "$ufw_dir/after6.rules" ""
fi
ufw reload

# In force: Docker's jump, and this script's rules where it put them.
https="-p tcp -m conntrack --ctstate DNAT --ctdir ORIGINAL --ctorigdstport 443 -j $chain"
if ! has_rule FORWARD "-j DOCKER-USER" || ! has_rule DOCKER-USER "$https" ||
  ! has_rule ufw-before-input "-p tcp --dport 443 -j $chain"; then
  echo "The rules are written, but not in force after the reload: see \`sudo iptables -S DOCKER-USER\` and \`sudo iptables -S $chain\`." >&2
  exit 1
fi
if [ "$ipv6" = true ] && ! has_rule ufw6-before-input "-p tcp --dport 443 -j $chain" ip6tables; then
  echo "The IPv6 rules are written, but not in force after the reload: see \`sudo ip6tables -S $chain\`." >&2
  exit 1
fi

echo "Ports 80 and 443 now take only Cloudflare's ${#v4[@]} IPv4 ranges (from $from)."
if [ "$ipv6" = true ]; then
  echo "And for IPv6, its ${#v6[@]} IPv6 ranges."
  if ! has_rule FORWARD "-j DOCKER-USER" ip6tables; then
    echo "(Docker has no IPv6 firewall here: IPv6 connections reach its proxy on the server, where these rules apply.)"
  fi
else
  echo "Warning: IPv6 is not limited. UFW's IPv6 rules are off (IPV6=no in /etc/default/ufw), so it loads no after6.rules. Set IPV6=yes and run this again, or make sure the server has no public IPv6 address." >&2
fi
echo "Check with: sudo iptables -S DOCKER-USER; sudo iptables -S $chain (and ip6tables)."
